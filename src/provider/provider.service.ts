import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ProviderEventDto } from './dto/provider-event.dto';

export interface EventResult {
  success: boolean;
  duplicate: boolean;
  message: string;
}

@Injectable()
export class ProviderService {
  constructor(private readonly dbService: DatabaseService) {}

  processEvent(event: ProviderEventDto): EventResult {
    const db = this.dbService.getDb();
    
    // Pre-flight checks outside main transaction (read-only, can throw without rollback concerns)
    // These checks don't modify state, so exceptions here are safe
    
    // 1. Wallet must exist
    const wallet = db.prepare('SELECT id, currency, balance_kobo FROM wallets WHERE id = ?').get(event.walletId) as any;
    if (!wallet) {
      throw new NotFoundException(`Wallet ${event.walletId} not found`);
    }

    // 2. Currency must match wallet
    if (wallet.currency !== event.currency) {
      throw new ConflictException(`Currency mismatch: wallet is ${wallet.currency}, event is ${event.currency}`);
    }

    // 3. Check if eventId already exists
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
        return { success: true, duplicate: true, message: 'Event already processed with same payload' };
      }

      // Different payload with same eventId - persist rejection in separate transaction, then throw
      // Separate transaction ensures audit record survives the exception
      db.transaction(() => {
        db.prepare(`
          INSERT INTO rejected_events (event_id, raw_payload, reason)
          VALUES (?, ?, ?)
        `).run(event.eventId, JSON.stringify(event), 'Duplicate eventId with different payload');
      }).immediate();
      
      throw new ConflictException('Event ID already used with different payload');
    }
    
    // ALL state-changing operations run inside ONE synchronous transaction
    // .immediate() prevents concurrent writers from starting
    // If this transaction throws, ALL changes within it roll back
    const result = db.transaction(() => {

      // 4. Check if transactionRef already exists
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
          // Persist rejection in nested transaction (commits immediately), then throw
          // Nested transaction commits independently - audit record survives the outer rollback
          db.transaction(() => {
            db.prepare(`
              INSERT INTO rejected_events (event_id, raw_payload, reason)
              VALUES (?, ?, ?)
            `).run(event.eventId, JSON.stringify(event), 'Transaction attributes mismatch');
          }).immediate();
          
          throw new ConflictException('Transaction reference exists with different attributes');
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
          
          return { success: true, duplicate: false, message: 'Duplicate pending event ignored' };
        }

        // pending + successful -> credit balance
        if (currentStatus === 'pending' && newStatus === 'successful') {
          // Update transaction status
          db.prepare('UPDATE transactions SET status = ?, updated_at = datetime("now") WHERE transaction_ref = ?')
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

          return { success: true, duplicate: false, message: 'Transaction completed successfully' };
        }

        // pending + failed -> mark failed, no credit
        if (currentStatus === 'pending' && newStatus === 'failed') {
          db.prepare('UPDATE transactions SET status = ?, updated_at = datetime("now") WHERE transaction_ref = ?')
            .run('failed', event.transactionRef);

          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'applied');

          return { success: true, duplicate: false, message: 'Transaction marked as failed' };
        }

        // terminal + pending -> ignore late event
        if ((currentStatus === 'successful' || currentStatus === 'failed') && newStatus === 'pending') {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'ignored_late');

          return { success: true, duplicate: false, message: 'Late pending event ignored' };
        }

        // terminal + same terminal -> no-op
        if (currentStatus === newStatus && (newStatus === 'successful' || newStatus === 'failed')) {
          db.prepare(`
            INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'duplicate_noop');

          return { success: true, duplicate: false, message: 'Duplicate terminal status ignored' };
        }

        // successful <-> failed conflict (opposite terminal states)
        if (
          (currentStatus === 'successful' && newStatus === 'failed') ||
          (currentStatus === 'failed' && newStatus === 'successful')
        ) {
          // Persist conflict event in nested transaction (commits immediately), then throw
          // Nested transaction commits independently - conflict audit survives the outer rollback
          db.transaction(() => {
            db.prepare(`
              INSERT INTO provider_events (event_id, transaction_ref, wallet_id, amount_kobo, currency, status, outcome)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(event.eventId, event.transactionRef, event.walletId, event.amountKobo, event.currency, event.status, 'conflict_terminal');
          }).immediate();

          throw new ConflictException('Terminal status conflict - manual review required');
        }
      } else {
        // 5. New transaction - insert and apply immediately if successful
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

        return { success: true, duplicate: false, message: 'New transaction processed' };
      }

      // Should never reach here
      throw new Error('Unhandled state transition');
    }).immediate();

    return result;
  }
}
