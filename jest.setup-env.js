/**
 * Runs before any test file is loaded.
 *
 * This must happen before modules are imported: `ConfigModule.forRoot()` in the Nest app modules
 * snapshots `process.env` when the module file is first loaded, so setting env vars inside
 * `beforeAll` would be too late and config validation would fail.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://payments:payments@localhost:5432/payments';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.PROCESSOR_WEBHOOK_SECRET ??= 'test-webhook-secret-123456';
