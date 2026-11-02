import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import { createDb, DB, recordFinding, resolveFinding } from '@app/db';
import { createMetrics, METRICS } from '@app/observability';
import type { AppMetrics } from '@app/observability';
import { createAttemptInStatus, createMerchant, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { ProcessorLookup } from './processor-lookup';
import { RecoveryService } from './recovery.service';
import type { RecoveryLoopOptions } from './recovery.service';
import { WORKER_HTTP_OPTIONS, WorkerHttpService } from './worker-http.service';
import type { WorkerHttpOptions } from './worker-http.service';

describe('worker observability (Postgres + fake processor)', () => {
  let pg: TestPostgres;
  const modules: TestingModule[] = [];

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    for (const m of modules) await m.close();
    await pg?.stop();
  });

  async function startWorkerHttp(over: Partial<WorkerHttpOptions> = {}, db = pg.db) {
    const metrics = createMetrics();
    const mod = await Test.createTestingModule({
      providers: [
        WorkerHttpService,
        { provide: DB, useValue: db },
        { provide: METRICS, useValue: metrics },
        { provide: WORKER_HTTP_OPTIONS, useValue: { port: 0, readinessTimeoutMs: 1000, ...over } },
      ],
    }).compile();
    modules.push(mod);
    await mod.init();
    return { metrics, url: `http://127.0.0.1:${mod.get(WorkerHttpService).port}` };
  }

  const scrape = async (url: string, headers: Record<string, string> = {}) => fetch(`${url}/metrics`, { headers });
  async function sample(url: string, series: string): Promise<number | undefined> {
    const line = (await (await scrape(url)).text()).split('\n').find((l) => l.startsWith(`${series} `));
    return line ? Number(line.split(' ')[1]) : undefined;
  }

  describe('the worker http listener', () => {
    it('exports database state as gauges: stuck attempts, their idle time, open findings', async () => {
      const { url } = await startWorkerHttp();
      const merchantId = await createMerchant(pg.db);
      const before = (await sample(url, 'payment_attempts_in_state{status="calling_processor"}')) ?? 0;
      await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
      await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
      await recordFinding(pg.db, { kind: 'orphan_charge', source: 'reconciliation', dedupeKey: `o:${uid()}`, chargeId: `ch_${uid()}`, detail: 'x', now: new Date() });

      expect(await sample(url, 'payment_attempts_in_state{status="calling_processor"}')).toBe(before + 2);
      expect(await sample(url, 'payment_attempts_oldest_idle_seconds{status="calling_processor"}')).toBeGreaterThanOrEqual(0);
      expect(await sample(url, 'reconciliation_findings_open{kind="orphan_charge"}')).toBeGreaterThanOrEqual(1);
      expect(await sample(url, 'attempts_missing_outbox_event')).toBe(0);
      expect(await sample(url, 'ledger_invariant_violations')).toBe(0);
    });

    it('a finding kind that has been fully resolved reads 0, not its last value', async () => {
      const { url } = await startWorkerHttp();
      const finding = await recordFinding(pg.db, { kind: 'charge_id_conflict', source: 'reconciliation', dedupeKey: `c:${uid()}`, chargeId: `ch_${uid()}`, detail: 'x', now: new Date() });
      expect(await sample(url, 'reconciliation_findings_open{kind="charge_id_conflict"}')).toBe(1);

      await resolveFinding(pg.db, finding.id, 'looked at it', new Date());
      // the kind has no open rows now; its series must be gone or zero, never stuck at 1
      expect((await sample(url, 'reconciliation_findings_open{kind="charge_id_conflict"}')) ?? 0).toBe(0);
    });

    it('needs the token when one is set; probes never do', async () => {
      const { url } = await startWorkerHttp({ metricsToken: 'worker-token-0123456789' });
      expect((await scrape(url)).status).toBe(401);
      expect((await scrape(url, { authorization: 'Bearer worker-token-0123456789' })).status).toBe(200);
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    });

    it('answers 404 for other paths and 405 for other methods', async () => {
      const { url } = await startWorkerHttp();
      expect((await fetch(`${url}/nope`)).status).toBe(404);
      expect((await fetch(`${url}/metrics`, { method: 'POST' })).status).toBe(405);
    });

    it('with the database gone: not ready, and the scrape reports the error instead of a reassuring zero', async () => {
      const db = createDb(pg.connectionString, { maxConnections: 2 });
      const { url } = await startWorkerHttp({}, db);
      await createAttemptInStatus(pg.db, 'processing');
      const healthy = await sample(url, 'payment_attempts_in_state{status="processing"}');
      expect(healthy).toBeGreaterThanOrEqual(1);

      await db.destroy();

      const ready = await fetch(`${url}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'unavailable', failed: ['database'] });
      expect(await sample(url, 'stats_scrape_errors_total')).toBeGreaterThanOrEqual(1);
      expect(await sample(url, 'payment_attempts_in_state{status="processing"}')).toBe(healthy); // last known value, not 0
      expect((await fetch(`${url}/health`)).status).toBe(200);
    });
  });

  describe('job metrics (RecoveryService against the fake processor)', () => {
    let processorApp: NestExpressApplication;
    let processorBase: string;
    let service: RecoveryService | undefined;

    beforeAll(async () => {
      const mod = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
      processorApp = mod.createNestApplication<NestExpressApplication>({ logger: false });
      await processorApp.listen(0, '127.0.0.1');
      processorBase = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');
    });

    afterAll(async () => {
      await service?.onApplicationShutdown();
      await processorApp?.close();
    });

    it('counts sweeper runs, what it applied, and findings by kind', async () => {
      const metrics: AppMetrics = createMetrics();
      const policy = { stuckAfterMs: 0, abandonedGraceMs: 60 * 60_000 };
      const options: RecoveryLoopOptions = {
        sweepIntervalMs: 50,
        reconcileIntervalMs: 50,
        sweeper: { ...policy, pendingAfterMs: 0, claimStaleAfterMs: 60_000, batchSize: 100, concurrency: 2, feeBps: 150 },
        reconciler: { ...policy, lookbackMs: 48 * 60 * 60_000, feeBps: 150 },
      };
      const merchantId = await createMerchant(pg.db);
      const ok = await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
      const bad = await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
      const reference = async (id: number) =>
        (await pg.db.selectFrom('payment_attempts').select('processor_idempotency_key').where('id', '=', id).executeTakeFirstOrThrow()).processor_idempotency_key;
      const charge = (ref: string, amount: number) =>
        fetch(`${processorBase}/v1/charges`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': ref },
          body: JSON.stringify({ amount, currency: 'NGN', metadata: { reference: ref } }),
        });
      await charge(await reference(ok.attemptId), 5000);
      await charge(await reference(bad.attemptId), 9999); // wrong amount: a finding, never an overwrite

      service = new RecoveryService(pg.db, new ProcessorLookup({ baseUrl: processorBase, timeoutMs: 2000 }), options, metrics);
      service.onApplicationBootstrap();
      const read = async (series: string) => {
        const line = (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`${series} `));
        return line ? Number(line.split(' ')[1]) : 0;
      };
      // The sweeper and the reconciler both heal the stuck attempt and whichever gets there first counts it (applied vs repaired).
      const healed = async () => (await read('recovery_actions_total{action="applied"}')) + (await read('recovery_actions_total{action="repaired"}'));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && ((await healed()) < 1 || (await read('reconciliation_findings_recorded_total{kind="amount_mismatch"}')) < 1)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await service.onApplicationShutdown();

      expect(await healed()).toBeGreaterThanOrEqual(1);
      expect(await read('recovery_runs_total{job="sweeper",result="ok"}')).toBeGreaterThanOrEqual(1);
      expect(await read('recovery_runs_total{job="reconciler",result="ok"}')).toBeGreaterThanOrEqual(1);
      expect(await read('reconciliation_findings_recorded_total{kind="amount_mismatch"}')).toBeGreaterThanOrEqual(1);
      expect((await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', ok.attemptId).executeTakeFirstOrThrow()).status).toBe('succeeded');
      await sql`select 1`.execute(pg.db);
    });

    it('counts a failed run as an error and keeps running', async () => {
      const metrics = createMetrics();
      const down = new ProcessorLookup({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });
      const policy = { stuckAfterMs: 0, abandonedGraceMs: 60 * 60_000 };
      const failing = new RecoveryService(
        pg.db,
        down,
        {
          sweepIntervalMs: 50,
          reconcileIntervalMs: 50,
          sweeper: { ...policy, pendingAfterMs: 0, claimStaleAfterMs: 60_000, batchSize: 100, concurrency: 2, feeBps: 150 },
          reconciler: { ...policy, lookbackMs: 60_000, feeBps: 150 },
        },
        metrics,
      );
      failing.onApplicationBootstrap();
      const deadline = Date.now() + 8000;
      const read = async () => (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith('recovery_runs_total{job="reconciler",result="error"} '));
      while (Date.now() < deadline && !(await read())) await new Promise((r) => setTimeout(r, 50));
      await failing.onApplicationShutdown();
      expect(await read()).toBeDefined();
    });
  });
});
