import { z } from 'zod';

/**
 * Single source of truth for configuration.
 * Validated once at startup so a missing or malformed value fails fast and loudly,
 * rather than surfacing as a confusing runtime error in the middle of a payment.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  API_PORT: z.coerce.number().int().positive().default(3000),
  FAKE_PROCESSOR_PORT: z.coerce.number().int().positive().default(3001),

  /** Where the API/worker send outbound charge calls (the fake processor in dev). */
  PROCESSOR_BASE_URL: z.string().min(1).default('http://localhost:3001'),
  /** How long to wait for the processor before treating the outcome as unknown (not as a failure). */
  PROCESSOR_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** Extra tries after an UNKNOWN outcome, always with the same processor idempotency key. */
  PROCESSOR_CALL_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** First pause between those tries; doubles each time. */
  PROCESSOR_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(200),
  /** The platform's fee on each successful payment, in basis points (150 = 1.5%). Booked to the ledger. */
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(150),
  /** Shared secret used to sign and verify webhooks (Stage 4 and Stage 7). */
  PROCESSOR_WEBHOOK_SECRET: z.string().min(16, 'PROCESSOR_WEBHOOK_SECRET must be at least 16 chars'),
  /** Optional: where the fake processor delivers webhooks at start-up (can also be set at runtime). */
  FAKE_PROCESSOR_WEBHOOK_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
