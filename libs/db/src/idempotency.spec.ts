import type { Kysely } from 'kysely';
import { InvalidIdempotencyKeyError, NonCanonicalValueError } from '../../payments-core/src';
import type { Database } from './database.types';
import { claimKey, completeKey, releaseClaim } from './idempotency';

/** Explodes if anything touches it: proves bad input is refused BEFORE any query is sent. */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched');
    },
  },
) as unknown as Kysely<Database>;

const request = { operation: 'POST /v1/payments', body: { order_id: 'o1', amount: 100 } };

describe('idempotency helpers: checks that happen before any query', () => {
  it.each(['', ' ', 'has space', 'x'.repeat(256), 'clé', 'a\nb'])(
    'claimKey refuses the key %j',
    async (key) => {
      await expect(claimKey(untouchableDb, { merchantId: 1, key, request })).rejects.toBeInstanceOf(
        InvalidIdempotencyKeyError,
      );
    },
  );

  it('claimKey refuses a request body that has no canonical form', async () => {
    await expect(
      claimKey(untouchableDb, { merchantId: 1, key: 'k', request: { operation: 'op', body: { a: undefined } } }),
    ).rejects.toBeInstanceOf(NonCanonicalValueError);
    await expect(
      claimKey(untouchableDb, { merchantId: 1, key: 'k', request: { operation: 'op', body: { a: Number.NaN } } }),
    ).rejects.toBeInstanceOf(NonCanonicalValueError);
  });

  it('completeKey refuses a bad key', async () => {
    await expect(
      completeKey(untouchableDb, { merchantId: 1, key: '', response: { status: 200 } }),
    ).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
  });

  it.each([99, 600, 200.5, Number.NaN, -1])('completeKey refuses the response status %p', async (status) => {
    await expect(
      completeKey(untouchableDb, { merchantId: 1, key: 'k', response: { status } }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('releaseClaim refuses a bad key', async () => {
    await expect(releaseClaim(untouchableDb, 1, 'bad key')).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
  });
});
