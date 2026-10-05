import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('Provider Events (e2e)', () => {
  let app: INestApplication;
  let dbService: DatabaseService;

  beforeEach(async () => {
    // Use in-memory database for each test
    process.env.DB_PATH = ':memory:';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    
    // Same validation pipe as production
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    );

    await app.init();
    dbService = moduleFixture.get<DatabaseService>(DatabaseService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('1. pending T001 250000 then successful T001 -> balance 250000, exactly one T001 in history', async () => {
    // Send pending event
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E001',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'pending'
      })
      .expect(200);

    // Send successful event
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E002',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Check wallet
    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(250000);
    expect(response.body.transactions).toHaveLength(1);
    expect(response.body.transactions[0].reference).toBe('T001');
    expect(response.body.transactions[0].status).toBe('successful');
  });

  it('2. replay successful event (same eventId) -> balance unchanged; new eventId successful for T001 -> still 250000', async () => {
    // Initial successful event
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E003',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Replay same event (same eventId, same payload)
    const replayResponse = await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E003',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    expect(replayResponse.body.duplicate).toBe(true);

    // Send another successful event with new eventId for same transaction
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E004',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Balance should still be 250000 (credited only once)
    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(250000);
  });

  it('3. failed T002 100000 -> balance stays 250000, T002 shows failed', async () => {
    // Setup: credit 250000 first
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E005',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Send failed transaction
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E006',
        transactionRef: 'T002',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'failed'
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(250000);
    expect(response.body.transactions).toHaveLength(2);
    
    const t002 = response.body.transactions.find((tx: any) => tx.reference === 'T002');
    expect(t002.status).toBe('failed');
  });

  it('4. late pending (new eventId) for successful T001 -> status stays successful, balance 250000', async () => {
    // Send successful first
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E007',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Send late pending
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E008',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'pending'
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(250000);
    expect(response.body.transactions[0].status).toBe('successful');
  });

  it('5. negative amount -> 400', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E009',
        transactionRef: 'T003',
        walletId: 'W001',
        amountKobo: -100,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(400);
  });

  it('6. conflicting amount for T001 -> 409, balance unchanged', async () => {
    // Initial transaction
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E010',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 250000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Conflicting amount
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E011',
        transactionRef: 'T001',
        walletId: 'W001',
        amountKobo: 300000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(409);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(250000);
  });

  it('unknown wallet -> 404', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E012',
        transactionRef: 'T004',
        walletId: 'W999',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(404);
  });

  it('float amount -> 400', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E013',
        transactionRef: 'T005',
        walletId: 'W001',
        amountKobo: 100.5,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(400);
  });

  it('string amount -> 400', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E014',
        transactionRef: 'T006',
        walletId: 'W001',
        amountKobo: '250000',
        currency: 'NGN',
        status: 'successful'
      })
      .expect(400);
  });

  it('zero amount -> 400', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E015',
        transactionRef: 'T007',
        walletId: 'W001',
        amountKobo: 0,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(400);
  });

  it('wrong currency -> 400', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E016',
        transactionRef: 'T008',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'USD',
        status: 'successful'
      })
      .expect(400);
  });

  it('reused eventId with different payload -> 409', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E017',
        transactionRef: 'T009',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Same eventId, different transactionRef
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E017',
        transactionRef: 'T010',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(409);
  });

  it('opposite terminal event (successful then failed) -> 409, status and balance unchanged', async () => {
    // Successful first
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E018',
        transactionRef: 'T011',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    // Try to mark as failed
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E019',
        transactionRef: 'T011',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'failed'
      })
      .expect(409);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    const t011 = response.body.transactions.find((tx: any) => tx.reference === 'T011');
    expect(t011.status).toBe('successful');
    expect(response.body.availableBalanceKobo).toBe(100000);
  });

  it('successful with no prior pending credits once', async () => {
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E020',
        transactionRef: 'T012',
        walletId: 'W001',
        amountKobo: 150000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    expect(response.body.availableBalanceKobo).toBe(150000);
    expect(response.body.transactions).toHaveLength(1);
    expect(response.body.transactions[0].status).toBe('successful');
  });

  it('two concurrent successful requests with different eventIds for same ref -> credited once', async () => {
    // Simulate concurrent requests with Promise.all
    const results = await Promise.all([
      request(app.getHttpServer())
        .post('/provider/events')
        .send({
          eventId: 'E021',
          transactionRef: 'T013',
          walletId: 'W001',
          amountKobo: 200000,
          currency: 'NGN',
          status: 'successful'
        }),
      request(app.getHttpServer())
        .post('/provider/events')
        .send({
          eventId: 'E022',
          transactionRef: 'T013',
          walletId: 'W001',
          amountKobo: 200000,
          currency: 'NGN',
          status: 'successful'
        })
    ]);

    // Both should succeed (one applies, one is duplicate terminal)
    expect([200, 200]).toContain(results[0].status);
    expect([200, 200]).toContain(results[1].status);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    // Should be credited only once
    expect(response.body.availableBalanceKobo).toBe(200000);
    
    // Verify ledger has exactly one entry
    const db = dbService.getDb();
    const ledgerEntries = db.prepare('SELECT COUNT(*) as count FROM ledger_entries WHERE transaction_ref = ?').get('T013') as any;
    expect(ledgerEntries.count).toBe(1);
  });

  it('invariant test: balance equals sum of ledger_entries', async () => {
    // Create multiple transactions
    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E023',
        transactionRef: 'T014',
        walletId: 'W001',
        amountKobo: 100000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E024',
        transactionRef: 'T015',
        walletId: 'W001',
        amountKobo: 50000,
        currency: 'NGN',
        status: 'successful'
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/provider/events')
      .send({
        eventId: 'E025',
        transactionRef: 'T016',
        walletId: 'W001',
        amountKobo: 25000,
        currency: 'NGN',
        status: 'failed'
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/wallets/W001')
      .expect(200);

    // Query ledger sum directly
    const db = dbService.getDb();
    const ledgerSum = db.prepare('SELECT COALESCE(SUM(amount_kobo), 0) as total FROM ledger_entries WHERE wallet_id = ?').get('W001') as any;

    expect(response.body.availableBalanceKobo).toBe(ledgerSum.total);
    expect(response.body.availableBalanceKobo).toBe(150000); // 100000 + 50000, failed doesn't count
  });
});
