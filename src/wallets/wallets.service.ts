import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Transaction {
  reference: string;
  amountKobo: number;
  currency: string;
  status: string;
}

export interface WalletDetails {
  walletId: string;
  customerId: string;
  currency: string;
  availableBalanceKobo: number;
  transactions: Transaction[];
}

@Injectable()
export class WalletsService {
  constructor(private readonly dbService: DatabaseService) {}

  getWallet(walletId: string): WalletDetails {
    const db = this.dbService.getDb();
    
    // Get wallet details
    const wallet = db.prepare(
      'SELECT id, customer_id, currency, balance_kobo FROM wallets WHERE id = ?'
    ).get(walletId) as any;

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    // Get all transactions ordered by created_at, then rowid for tie-breaking
    const transactions = db.prepare(`
      SELECT transaction_ref, amount_kobo, currency, status
      FROM transactions
      WHERE wallet_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(walletId) as any[];

    return {
      walletId: wallet.id,
      customerId: wallet.customer_id,
      currency: wallet.currency,
      availableBalanceKobo: wallet.balance_kobo,
      transactions: transactions.map(tx => ({
        reference: tx.transaction_ref,
        amountKobo: tx.amount_kobo,
        currency: tx.currency,
        status: tx.status
      }))
    };
  }
}
