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
