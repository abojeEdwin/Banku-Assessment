import { Injectable, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private db!: Database.Database;

  onModuleInit() {
    const dbPath = process.env.DB_PATH || './wallet.db';
    this.db = new Database(dbPath);
    
    // Enable foreign key constraints - critical for referential integrity
    this.db.pragma('foreign_keys = ON');
    
    this.initSchema();
    this.seedData();
  }

  getDb(): Database.Database {
    return this.db;
  }

  private initSchema() {
    // Idempotent schema creation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        balance_kobo INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS transactions (
        transaction_ref TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
        currency TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'successful', 'failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      );

      CREATE TABLE IF NOT EXISTS provider_events (
        event_id TEXT PRIMARY KEY,
        transaction_ref TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        amount_kobo INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'successful', 'failed')),
        outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'duplicate_noop', 'ignored_late', 'conflict_terminal')),
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_ref TEXT NOT NULL UNIQUE,
        wallet_id TEXT NOT NULL,
        amount_kobo INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      );

      CREATE TABLE IF NOT EXISTS rejected_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private seedData() {
    // Idempotent seeding - only insert if not exists
    const existing = this.db.prepare('SELECT id FROM wallets WHERE id = ?').get('W001');
    
    if (!existing) {
      this.db.prepare(`
        INSERT INTO wallets (id, customer_id, currency, balance_kobo)
        VALUES (?, ?, ?, ?)
      `).run('W001', 'C001', 'NGN', 0);
    }
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
    }
  }
}
