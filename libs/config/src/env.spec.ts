import { loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://payments:payments@localhost:5432/payments',
  REDIS_URL: 'redis://localhost:6379',
  PROCESSOR_WEBHOOK_SECRET: 'a-sufficiently-long-secret',
};

describe('loadEnv', () => {
  it('applies defaults for optional values', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3000);
    expect(env.FAKE_PROCESSOR_PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PROCESSOR_TIMEOUT_MS).toBe(5000);
    expect(env.PROCESSOR_CALL_RETRIES).toBe(2);
    expect(env.PROCESSOR_RETRY_DELAY_MS).toBe(200);
    expect(env.PROCESSOR_RETRY_MAX_DELAY_MS).toBe(2000);
    expect(env.PLATFORM_FEE_BPS).toBe(150);
    expect(env).toMatchObject({
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_BATCH_SIZE: 50,
      OUTBOX_MAX_ATTEMPTS: 10,
      OUTBOX_LEASE_MS: 60_000,
      OUTBOX_DELIVERY_TIMEOUT_MS: 5000,
      OUTBOX_RETRY_BASE_MS: 1000,
      OUTBOX_RETRY_MAX_MS: 3_600_000,
    });
  });

  it.each([
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_BATCH_SIZE', '501'],
    ['OUTBOX_MAX_ATTEMPTS', '0'],
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
    ['OUTBOX_LEASE_MS', '-5'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadEnv({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });

  it.each(['-1', '10001', '1.5'])('refuses a fee of %s basis points', (bps) => {
    expect(() => loadEnv({ ...valid, PLATFORM_FEE_BPS: bps })).toThrow(/PLATFORM_FEE_BPS/);
  });

  it('refuses an unreasonable number of call retries', () => {
    expect(() => loadEnv({ ...valid, PROCESSOR_CALL_RETRIES: '50' })).toThrow(/PROCESSOR_CALL_RETRIES/);
  });

  it('coerces numeric strings, since process.env values are always strings', () => {
    const env = loadEnv({ ...valid, API_PORT: '8080' });
    expect(env.API_PORT).toBe(8080);
  });

  it('fails fast when a required value is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a webhook secret that is too short to be safe', () => {
    expect(() => loadEnv({ ...valid, PROCESSOR_WEBHOOK_SECRET: 'short' })).toThrow(
      /PROCESSOR_WEBHOOK_SECRET/,
    );
  });
});
