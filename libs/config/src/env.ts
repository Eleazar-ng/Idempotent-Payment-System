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
  /** Shared secret used to sign and verify webhooks (Stage 4 and Stage 7). */
  PROCESSOR_WEBHOOK_SECRET: z.string().min(16, 'PROCESSOR_WEBHOOK_SECRET must be at least 16 chars'),
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
