import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ProviderEventDto } from './dto/provider-event.dto';

export interface EventResult {
  success: boolean;
  duplicate: boolean;
  message: string;
}

type TransactionOutcome = 
  | { result: EventResult }
  | { conflict: string };

@Injectable()
export class ProviderService {
  constructor(private readonly dbService: DatabaseService) {}

  processEvent(event: ProviderEventDto): EventResult {
    const db = this.dbService.getDb();
    
    // Pre-flight checks (read-only, safe to throw)
    const wallet = db.prepare('SELECT id, currency, balance_kobo FROM wallets WHERE id = ?').get(event.walletId) as any;
    if (!wallet) {
      throw new NotFoundException(`Wallet ${event.walletId} not found`);
    }

    if (wallet.currency !== event.currency) {
      throw new ConflictException(`Currency mismatch: wallet is ${wallet.currency}, event is ${event.currency}`);
    }

    // ALL operations inside ONE synchronous transaction
    // .immediate() prevents concurrent writers
    // Audit records written inside transaction, conflicts returned as markers (not thrown)
    const outcome: TransactionOutcome = db.transaction(() => {
      // Check eventId (inside transaction to prevent race conditions with multiple processes)
      const existingEvent = db.prepare(
        'SELECT event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome FROM provider_events WHERE event_id = ?'
      ).get(event.eventId) as any;

      if (existingEvent) {
        // Identical payload? Return stored result (idempotent)
        if (
          existingEvent.transaction_ref === event.transactionRef &&
          existingEvent.wallet_id === event.walletId &&
          existingEvent.amount_kobo === event.amountKobo &&
          existingEvent.currency === event.currency &&
          existingEvent.status === event.status
        ) {
          // Check if this was a previously recorded conflict - should return 409 not 200
          if (existingEvent.outcome === 'conflict_terminal') {
            return { conflict: 'Terminal status conflict - manual review required' };
          }
          return { result: { success: true, duplicate: true, message: 'Event already processed with same payload' } };
        }

        // Different payload - write to rejected_events, return conflict marker
        db.prepare(`
          INSERT INTO rejected_events (event_id, raw_payload, reason)
          VALUES (?, ?, ?)
        `).run(event.eventId, JSON.stringify(event), 'Duplicate eventId with different payload');
        
        return { conflict: 'Event ID already used with different payload' };
      }

      // Check if transactionRef exists
      const existingTxn = db.prepare(
        'SELECT transaction_ref, wallet_id, amount_kobo, currency, status FROM transactions WHERE transaction_ref = ?'
      ).get(event.transactionRef) as any;

      if (existingTxn) {
        // Validate immutable transaction attributes
        if (
          existingTxn.wallet_id !== event.walletId ||
          existingTxn.amount_kobo !== event.amountKobo ||
          existingTxn.currency !== event.currency
        ) {
          // Write to rejected_events, return conflict marker (transaction will commit this)
          db.prepare(`
            INSERT INTO rejected_events (event_id, raw_payload, reason)
            VALUES (?, ?, ?)
          `).run(event.eventId, JSON.stringify(event), 'Transaction attributes mismatch');
          
          return { conflict: 'Transaction reference exists with different attributes' };
        }

        // Apply state transition rules
        const currentStatus = existingTxn.status;
        const newStatus = event.status;

        // pending + pending -> no-op
        if (currentStatus === 'pending' && newStatus === 'pending') {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'duplicate_noop');
          
          return { result: { success: true, duplicate: false, message: 'Duplicate pending event ignored' } };
        }

        // pending + successful -> credit balance
        if (currentStatus === 'pending' && newStatus === 'successful') {
          // Update transaction status (fixed: single quotes for datetime)
          db.prepare("UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE transaction_ref = ?")
            .run('successful', event.transactionRef);

          // Insert ledger entry (UNIQUE constraint guarantees one credit per transaction)
          db.prepare(`
            INSERT INTO ledger_entries (transaction_ref, wallet_id, amount_kobo, event_id)
            VALUES (?, ?, ?, ?)
          `).run(event.transactionRef, event.walletId, event.amountKobo, event.eventId);

          // Credit balance atomically
          db.prepare('UPDATE wallets SET balance_kobo = balance_kobo + ? WHERE id = ?')
            .run(event.amountKobo, event.walletId);

          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'applied');

          return { result: { success: true, duplicate: false, message: 'Transaction completed successfully' } };
        }

        // pending + failed -> mark failed, no credit
        if (currentStatus === 'pending' && newStatus === 'failed') {
          db.prepare("UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE transaction_ref = ?")
            .run('failed', event.transactionRef);

          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'applied');

          return { result: { success: true, duplicate: false, message: 'Transaction marked as failed' } };
        }

        // terminal + pending -> ignore late event
        if ((currentStatus === 'successful' || currentStatus === 'failed') && newStatus === 'pending') {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'ignored_late');

          return { result: { success: true, duplicate: false, message: 'Late pending event ignored' } };
        }

        // terminal + same terminal -> no-op
        if (currentStatus === newStatus && (newStatus === 'successful' || newStatus === 'failed')) {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'duplicate_noop');

          return { result: { success: true, duplicate: false, message: 'Duplicate terminal status ignored' } };
        }

        // successful <-> failed conflict (opposite terminal states)
        // Write conflict to provider_events, return marker (transaction commits this row)
        if (
          (currentStatus === 'successful' && newStatus === 'failed') ||
          (currentStatus === 'failed' && newStatus === 'successful')
        ) {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'conflict_terminal');

          return { conflict: 'Terminal status conflict - manual review required' };
        }
      } else {
        // New transaction - insert and apply immediately if successful
        db.prepare(`
          INSERT INTO transactions (transaction_ref, wallet_id, amount_kobo, currency, status)
          VALUES (?, ?, ?, ?, ?)
        `).run(event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status);

        // If status is successful, credit immediately (no pending state required)
        if (event.status === 'successful') {
          db.prepare(`
            INSERT INTO ledger_entries (transaction_ref, wallet_id, amount_kobo, event_id)
            VALUES (?, ?, ?, ?)
          `).run(event.transactionRef, event.walletId, event.amountKobo, event.eventId);

          db.prepare('UPDATE wallets SET balance_kobo = balance_kobo + ? WHERE id = ?')
            .run(event.amountKobo, event.walletId);
        }

        db.prepare(`
          INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'applied');

        return { result: { success: true, duplicate: false, message: 'New transaction processed' } };
      }

      // Should never reach here
      throw new Error('Unhandled state transition');
    }).immediate();

    // Throw AFTER transaction commits (audit records persist)
    if ('conflict' in outcome) {
      throw new ConflictException(outcome.conflict);
    }
    
    return outcome.result;
  }
}
