import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';
import { createRequestHasher, hashV1, requestHasher, UnknownHashVersionError } from '../../payments-core/src';
import type { RequestFingerprint } from '../../payments-core/src';
import {
  createAttempt,
  createIntent,
  createMerchant,
  expectSqlState,
  PG,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';
import type { Database, Json } from './database.types';
import { claimKey, completeKey, releaseClaim } from './idempotency';
import type { StoredResponse } from './idempotency';
import type { Kysely } from 'kysely';

const OPERATION = 'POST /v1/payments';
const fp = (body: unknown, operation = OPERATION): RequestFingerprint => ({ operation, body });
const payment = { order_id: 'ord_1', amount: 5000, currency: 'NGN' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Stages 3.2 to 3.5 against a real Postgres: the atomic claim, the three conflict branches,
 * completion and replay, and the concurrent races that the whole design exists to survive.
 */
describe('idempotency keys (real Postgres)', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantId = await createMerchant(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const claim = (key: string, body: unknown = payment, merchant = merchantId, operation = OPERATION) =>
    claimKey(pg.db, { merchantId: merchant, key, request: fp(body, operation) });

  const rowFor = (key: string, merchant = merchantId) =>
    pg.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('merchant_id', '=', merchant)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();

  describe('the first request (claimed)', () => {
    it('inserts an in-flight row bound to the request hash and its version', async () => {
      const key = `k-${uid()}`;
      const result = await claim(key);

      expect(result.outcome).toBe('claimed');
      const row = await rowFor(key);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        merchant_id: merchantId,
        idempotency_key: key,
        request_hash: requestHasher.hash(fp(payment)).hash,
        hash_version: 1,
        attempt_id: null,
        response_status: null,
        response_body: null,
        completed_at: null,
      });
      expect(row!.created_at).toBeInstanceOf(Date);
    });
  });

  describe('a duplicate while the first is in flight', () => {
    it('is reported as in_flight, with the claim time so a later stage can detect a stuck claim', async () => {
      const key = `k-${uid()}`;
      const first = await claim(key);
      const second = await claim(key);

      expect(second.outcome).toBe('in_flight');
      if (first.outcome === 'claimed' && second.outcome === 'in_flight') {
        expect(second.record.created_at).toEqual(first.record.created_at);
      }
    });

    it('also treats a re-ordered but identical body as the same request', async () => {
      const key = `k-${uid()}`;
      await claim(key, { order_id: 'ord_1', amount: 5000, currency: 'NGN' });
      const again = await claim(key, { currency: 'NGN', amount: 5000, order_id: 'ord_1' });
      expect(again.outcome).toBe('in_flight');
    });
  });

  describe('the same key with a different request (mismatch)', () => {
    it.each([
      ['a different amount', { ...payment, amount: 5001 }, OPERATION],
      ['an extra field', { ...payment, note: 'x' }, OPERATION],
      ['a different operation', payment, 'POST /v1/refunds'],
    ])('is a mismatch for %s, while the first is still in flight', async (_name, body, operation) => {
      const key = `k-${uid()}`;
      await claim(key);
      const result = await claim(key, body, merchantId, operation);
      expect(result.outcome).toBe('mismatch');
    });

    it('is still a mismatch after the first request completed, never a replay of someone else’s response', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await completeKey(pg.db, { merchantId, key, response: { status: 201, body: { id: 'pay_1' } } });

      const result = await claim(key, { ...payment, amount: 9999 });
      expect(result.outcome).toBe('mismatch');
      expect(result).not.toHaveProperty('response');
    });

    it('does not change the stored row', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      const before = await rowFor(key);
      await claim(key, { ...payment, amount: 1 });
      expect(await rowFor(key)).toEqual(before);
    });
  });

  describe('completion and replay', () => {
    it('stores the response, and every later duplicate gets exactly that response', async () => {
      const key = `k-${uid()}`;
      await claim(key);

      const body: Json = {
        id: 'pay_123',
        amount: 5000,
        currency: 'NGN',
        status: 'succeeded',
        nested: { list: [1, 2.5, null, true, 'é😀'], empty: {} },
        big: 9007199254740991,
      };
      const done = await completeKey(pg.db, { merchantId, key, response: { status: 201, body } });
      expect(done.outcome).toBe('completed');

      for (let i = 0; i < 5; i++) {
        const replay = await claim(key);
        expect(replay.outcome).toBe('replay');
        if (replay.outcome === 'replay') {
          expect(replay.response).toEqual({ status: 201, body });
        }
      }
      // however many duplicates arrived, there is still exactly one row for the key
      const rows = await pg.db.selectFrom('idempotency_keys').selectAll().where('idempotency_key', '=', key).execute();
      expect(rows).toHaveLength(1);
    });

    it('replays error responses too, not only successes (a declined card stays declined)', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await completeKey(pg.db, {
        merchantId,
        key,
        response: { status: 402, body: { error: { code: 'card_declined' } } },
      });
      const replay = await claim(key);
      expect(replay).toMatchObject({
        outcome: 'replay',
        response: { status: 402, body: { error: { code: 'card_declined' } } },
      });
    });

    it('replays a response with no body as a null body', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await completeKey(pg.db, { merchantId, key, response: { status: 204 } });
      const replay = await claim(key);
      expect(replay).toMatchObject({ outcome: 'replay', response: { status: 204, body: null } });
    });

    it('records the completion time and links the payment attempt in the same write', async () => {
      const key = `k-${uid()}`;
      const intentId = await createIntent(pg.db, merchantId);
      const attemptId = await createAttempt(pg.db, intentId);

      await claim(key);
      const done = await completeKey(pg.db, { merchantId, key, attemptId, response: { status: 202, body: {} } });

      expect(done.outcome).toBe('completed');
      const row = await rowFor(key);
      expect(row!.attempt_id).toBe(attemptId);
      expect(row!.completed_at).toBeInstanceOf(Date);
      expect(row!.response_status).toBe(202);
    });

    it('is first-write-wins: a second completion changes nothing and returns the original response', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await completeKey(pg.db, { merchantId, key, response: { status: 201, body: { which: 'first' } } });

      const second = await completeKey(pg.db, { merchantId, key, response: { status: 500, body: { which: 'second' } } });

      expect(second).toMatchObject({
        outcome: 'already_completed',
        response: { status: 201, body: { which: 'first' } },
      });
      expect((await rowFor(key))!.response_body).toEqual({ which: 'first' });
    });

    it('says not_found for a key that was never claimed', async () => {
      const result = await completeKey(pg.db, { merchantId, key: `never-${uid()}`, response: { status: 200 } });
      expect(result).toEqual({ outcome: 'not_found' });
    });

    it('cannot link an attempt that does not exist, and leaves the claim in flight', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await expectSqlState(
        completeKey(pg.db, { merchantId, key, attemptId: 987654321, response: { status: 201 } }),
        PG.FOREIGN_KEY_VIOLATION,
      );
      expect((await claim(key)).outcome).toBe('in_flight');
    });

    it('commits together with the work in a transaction, or not at all', async () => {
      const key = `k-${uid()}`;
      await claim(key);

      await expect(
        pg.db.transaction().execute(async (trx) => {
          const done = await completeKey(trx, { merchantId, key, response: { status: 201, body: { id: 'x' } } });
          expect(done.outcome).toBe('completed');
          throw new Error('the work failed after the response was stored');
        }),
      ).rejects.toThrow('the work failed');

      // the response rolled back with the work, so the claim is still in flight
      expect((await claim(key)).outcome).toBe('in_flight');

      await pg.db.transaction().execute((trx) =>
        completeKey(trx, { merchantId, key, response: { status: 201, body: { id: 'x' } } }),
      );
      expect((await claim(key)).outcome).toBe('replay');
    });
  });

  describe('scoping', () => {
    it('the same key for two merchants is two independent claims', async () => {
      const other = await createMerchant(pg.db);
      const key = `shared-${uid()}`;

      expect((await claim(key, payment, merchantId)).outcome).toBe('claimed');
      expect((await claim(key, { different: 'body' }, other)).outcome).toBe('claimed');

      // and neither sees the other's request as a mismatch or a replay
      expect((await claim(key, payment, merchantId)).outcome).toBe('in_flight');
      expect((await claim(key, { different: 'body' }, other)).outcome).toBe('in_flight');
    });

    it('one merchant’s completed response is never replayed to another merchant', async () => {
      const other = await createMerchant(pg.db);
      const key = `shared-${uid()}`;
      await claim(key, payment, merchantId);
      await completeKey(pg.db, { merchantId, key, response: { status: 201, body: { secret: 'merchant-a' } } });

      const result = await claim(key, payment, other);
      expect(result.outcome).toBe('claimed');
    });

    it('rejects a claim for a merchant that does not exist', async () => {
      await expectSqlState(claim(`k-${uid()}`, payment, 987654321), PG.FOREIGN_KEY_VIOLATION);
    });
  });

  describe('releasing a claim', () => {
    it('lets the client’s retry start fresh when the request did nothing', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      expect(await releaseClaim(pg.db, merchantId, key)).toBe(true);
      expect(await rowFor(key)).toBeUndefined();
      expect((await claim(key)).outcome).toBe('claimed');
    });

    it('never releases a completed key', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      await completeKey(pg.db, { merchantId, key, response: { status: 201 } });
      expect(await releaseClaim(pg.db, merchantId, key)).toBe(false);
      expect((await claim(key)).outcome).toBe('replay');
    });

    it('never releases a claim that already has a payment attempt, because money may be moving', async () => {
      const key = `k-${uid()}`;
      const intentId = await createIntent(pg.db, merchantId);
      const attemptId = await createAttempt(pg.db, intentId);
      await claim(key);
      await pg.db
        .updateTable('idempotency_keys')
        .set({ attempt_id: attemptId })
        .where('merchant_id', '=', merchantId)
        .where('idempotency_key', '=', key)
        .execute();

      expect(await releaseClaim(pg.db, merchantId, key)).toBe(false);
      expect((await claim(key)).outcome).toBe('in_flight');
    });

    it('returns false for a key that does not exist', async () => {
      expect(await releaseClaim(pg.db, merchantId, `never-${uid()}`)).toBe(false);
    });
  });

  describe('hash versioning (Module 11.3)', () => {
    const hashV2 = ({ operation, body }: RequestFingerprint) => {
      const { metadata: _ignored, ...rest } = body as Record<string, unknown>;
      return `v2:${hashV1({ operation, body: rest })}`;
    };
    const upgraded = createRequestHasher({ versions: { 1: hashV1, 2: hashV2 }, current: 2 });

    it('a retry of a key stored under version 1 is still recognised after the upgrade', async () => {
      const key = `k-${uid()}`;
      await claim(key); // stored with version 1
      expect((await rowFor(key))!.hash_version).toBe(1);

      const afterUpgrade = await claimKey(pg.db, { merchantId, key, request: fp(payment), hasher: upgraded });
      expect(afterUpgrade.outcome).toBe('in_flight'); // NOT mismatch

      await completeKey(pg.db, { merchantId, key, response: { status: 201, body: { ok: true } } });
      const replay = await claimKey(pg.db, { merchantId, key, request: fp(payment), hasher: upgraded });
      expect(replay).toMatchObject({ outcome: 'replay', response: { status: 201 } });
    });

    it('a different payload against a version 1 row is still a mismatch after the upgrade', async () => {
      const key = `k-${uid()}`;
      await claim(key);
      const result = await claimKey(pg.db, {
        merchantId,
        key,
        request: fp({ ...payment, amount: 1 }),
        hasher: upgraded,
      });
      expect(result.outcome).toBe('mismatch');
    });

    it('new keys are stored under the new version', async () => {
      const key = `k-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: fp(payment), hasher: upgraded });
      expect((await rowFor(key))!.hash_version).toBe(2);
    });

    it('a build that does not know the stored version fails loudly rather than guessing (deploy readers first)', async () => {
      const key = `k-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: fp(payment), hasher: upgraded }); // version 2 row
      await expect(claim(key)).rejects.toBeInstanceOf(UnknownHashVersionError); // old build, version 1 only
    });
  });

  describe('a claim made inside an open transaction (why callers must use autocommit)', () => {
    async function holdClaimOpen(key: string, outcome: 'commit' | 'rollback') {
      const claimed = deferred();
      const release = deferred();
      const tx = pg.db
        .transaction()
        .execute(async (trx) => {
          const result = await claimKey(trx, { merchantId, key, request: fp(payment) });
          expect(result.outcome).toBe('claimed');
          claimed.resolve();
          await release.promise;
          if (outcome === 'rollback') throw new Error('rollback requested');
        })
        .catch((error: Error) => {
          if (error.message !== 'rollback requested') throw error;
        });
      await claimed.promise;
      return { release: release.resolve, tx };
    }

    it('makes a concurrent duplicate WAIT for the outcome, then report in_flight if it committed', async () => {
      const key = `k-${uid()}`;
      const held = await holdClaimOpen(key, 'commit');

      let settled = false;
      const duplicate = claim(key).then((r) => {
        settled = true;
        return r;
      });
      await sleep(300);
      expect(settled).toBe(false); // blocked behind the uncommitted claim, not racing past it

      held.release();
      await held.tx;
      expect((await duplicate).outcome).toBe('in_flight');
    });

    it('lets the waiting duplicate become the owner if the first claim rolled back', async () => {
      const key = `k-${uid()}`;
      const held = await holdClaimOpen(key, 'rollback');

      const duplicate = claim(key);
      await sleep(300);
      held.release();
      await held.tx;

      expect((await duplicate).outcome).toBe('claimed');
      expect(await rowFor(key)).toBeDefined();
    });
  });

  describe('a row deleted between the failed insert and the read (expiry cleanup)', () => {
    function blankSelects(limit: number) {
      const selects = new Set<unknown>();
      const stats = { inserts: 0, blanked: 0 };
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }: PluginTransformQueryArgs) {
          if (node.kind === 'InsertQueryNode') stats.inserts++;
          if (node.kind === 'SelectQueryNode') selects.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }: PluginTransformResultArgs) {
          if (selects.has(queryId) && stats.blanked < limit) {
            stats.blanked++;
            return { ...result, rows: [] }; // pretend the row vanished
          }
          return result;
        },
      };
      return { db: pg.db.withPlugin(plugin) as Kysely<Database>, stats };
    }

    it('tries to claim again instead of failing or misreporting', async () => {
      const key = `k-${uid()}`;
      await claim(key);

      const { db, stats } = blankSelects(1);
      const result = await claimKey(db, { merchantId, key, request: fp(payment) });

      expect(result.outcome).toBe('in_flight'); // second round found the row
      expect(stats.inserts).toBe(2);
    });

    it('gives up with a clear error rather than looping forever', async () => {
      const key = `k-${uid()}`;
      await claim(key);

      const { db, stats } = blankSelects(Number.POSITIVE_INFINITY);
      await expect(claimKey(db, { merchantId, key, request: fp(payment) })).rejects.toThrow(/could not settle/);
      expect(stats.inserts).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Stage 3.5: concurrency. These are the tests the whole design exists for.
  // ---------------------------------------------------------------------------------------------
  describe('concurrent requests with the same key', () => {
    const N = 50;

    it(`${N} simultaneous first requests: exactly one is claimed, the rest are in_flight`, async () => {
      const key = `race-${uid()}`;
      const results = await Promise.all(Array.from({ length: N }, () => claim(key)));

      const tally = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
      expect(tally).toEqual({ claimed: 1, in_flight: N - 1 });

      const rows = await pg.db.selectFrom('idempotency_keys').selectAll().where('idempotency_key', '=', key).execute();
      expect(rows).toHaveLength(1);
    });

    it(`${N} simultaneous requests doing real work: the work happens exactly once and everyone gets the same response`, async () => {
      const key = `race-${uid()}`;
      let workDone = 0;

      // A miniature request handler, as the API will be (Stage 5): claim, do the work once, store
      // the response; duplicates wait for it and replay it.
      async function handle(): Promise<StoredResponse> {
        for (;;) {
          const result = await claim(key);
          switch (result.outcome) {
            case 'claimed': {
              workDone++;
              await sleep(150); // the slow part: the processor call
              const response = { status: 201, body: { payment_id: `pay_${uid()}` } };
              const done = await completeKey(pg.db, { merchantId, key, response });
              return done.outcome === 'completed' ? response : (done as { response: StoredResponse }).response;
            }
            case 'replay':
              return result.response;
            case 'in_flight':
              await sleep(20);
              continue;
            case 'mismatch':
              throw new Error('unexpected mismatch');
          }
        }
      }

      const responses = await Promise.all(Array.from({ length: N }, () => handle()));

      expect(workDone).toBe(1);
      expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(responses[0].status).toBe(201);
    });

    it('racing requests with different bodies: the first body wins, everyone else is a mismatch or in_flight', async () => {
      const key = `race-${uid()}`;
      const bodyA = { ...payment, amount: 100 };
      const bodyB = { ...payment, amount: 200 };

      const attempts = Array.from({ length: N }, (_, i) => {
        const body = i % 2 === 0 ? bodyA : bodyB;
        return claim(key, body).then((result) => ({ body, result }));
      });
      const results = await Promise.all(attempts);

      const winners = results.filter((r) => r.result.outcome === 'claimed');
      expect(winners).toHaveLength(1);
      const winningBody = winners[0].body;

      for (const { body, result } of results) {
        if (result.outcome === 'claimed') continue;
        expect(result.outcome).toBe(body === winningBody ? 'in_flight' : 'mismatch');
      }
    });

    it(`${N} different keys at once never collide with each other`, async () => {
      const results = await Promise.all(Array.from({ length: N }, () => claim(`distinct-${uid()}`)));
      expect(results.every((r) => r.outcome === 'claimed')).toBe(true);
    });

    it('the same key used by 20 merchants at once is 20 independent claims', async () => {
      const merchants = await Promise.all(Array.from({ length: 20 }, () => createMerchant(pg.db)));
      const key = `multi-${uid()}`;
      const results = await Promise.all(merchants.map((m) => claim(key, payment, m)));
      expect(results.every((r) => r.outcome === 'claimed')).toBe(true);
    });

    it('20 simultaneous completions with different responses: exactly one is stored, all callers learn the winner', async () => {
      const key = `race-${uid()}`;
      await claim(key);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          completeKey(pg.db, { merchantId, key, response: { status: 200 + i, body: { caller: i } } }),
        ),
      );

      const completed = results.filter((r) => r.outcome === 'completed');
      expect(completed).toHaveLength(1);
      const winner = (await rowFor(key))!;
      for (const r of results) {
        if (r.outcome === 'already_completed') {
          expect(r.response).toEqual({ status: winner.response_status, body: winner.response_body });
        }
      }
      expect(results.filter((r) => r.outcome === 'already_completed')).toHaveLength(19);
    });
  });
});
