/** A valid environment for tests that need to construct config explicitly. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://payments:payments@localhost:5432/payments',
    REDIS_URL: 'redis://localhost:6379',
    PROCESSOR_WEBHOOK_SECRET: 'test-webhook-secret-123456',
    ...overrides,
  };
}
