import { z } from 'zod';

/** POST /v1/charges body. Stripe-flavoured, with uppercase ISO currency like our own database. */
export const chargeRequestSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO code'),
  /** A payment source token. A few magic values pick an outcome (see DEFAULT_SOURCE_BEHAVIOR). */
  source: z.string().min(1).default('tok_default'),
  /** Free-form tags. `metadata.reference` is what reconciliation searches by (Stage 9). */
  metadata: z.record(z.string(), z.string()).default({}),
});
export type ChargeRequest = z.infer<typeof chargeRequestSchema>;

export const OUTCOMES = ['succeed', 'decline', 'requires_action', 'pending'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Faults happen to the HTTP exchange, not to the charge. That separation is the whole point: the
 * hardest failures (Module 2.2) are the ones where the money moved and the caller never learned it.
 *
 *   gateway_error  503 before the processor sees anything. No charge, nothing stored.
 *   drop_before    connection closed before processing. No charge.
 *   error_after    charge processed and stored, but this response is a 500.
 *   drop_after     charge processed and stored, but the connection closes without a response.
 */
export const FAULTS = ['gateway_error', 'drop_before', 'error_after', 'drop_after'] as const;
export type Fault = (typeof FAULTS)[number];

export const ruleInputSchema = z
  .object({
    match: z
      .object({
        source: z.string().optional(),
        reference: z.string().optional(),
        idempotencyKey: z.string().optional(),
      })
      .default({}),
    /** What the charge itself does. Only used the FIRST time an idempotency key is processed. */
    outcome: z.enum(OUTCOMES).optional(),
    /** What happens to the HTTP exchange. Applies on every request the rule matches, replays included. */
    fault: z.enum(FAULTS).optional(),
    /** For outcome=decline: the failure code (default card_declined). */
    declineCode: z.string().min(1).optional(),
    /** Delay BEFORE processing, with the idempotency key marked in progress (concurrent duplicates get 409). */
    processingDelayMs: z.number().int().min(0).max(60_000).optional(),
    /** Delay AFTER processing, before responding: the charge exists but the client may time out. */
    responseDelayMs: z.number().int().min(0).max(60_000).optional(),
    /** How many matching requests the rule applies to. Default 1 (fail once, then recover). null = forever. */
    times: z.number().int().positive().nullable().default(1),
  })
  .refine(
    (rule) =>
      rule.outcome !== undefined ||
      rule.fault !== undefined ||
      rule.processingDelayMs !== undefined ||
      rule.responseDelayMs !== undefined,
    { message: 'a rule must set at least one of outcome, fault, processingDelayMs, responseDelayMs' },
  );
/** What callers write: `match` and `times` may be omitted (defaults: match everything, apply once). */
export type RuleInput = z.input<typeof ruleInputSchema>;

export const webhookConfigSchema = z.object({
  url: z.string().url().nullable().optional(),
  /** immediate: deliver as events happen. hold: keep events until flushed (to reorder them). */
  mode: z.enum(['immediate', 'hold']).optional(),
  /** Extra copies of every delivery (at-least-once means duplicates happen). */
  duplicates: z.number().int().min(0).max(10).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(0).max(60_000).optional(),
});
export type WebhookConfigInput = z.infer<typeof webhookConfigSchema>;

export const resolveSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  failureCode: z.string().min(1).optional(),
});

export const flushSchema = z.object({ order: z.enum(['fifo', 'reverse']).default('fifo') });
export const advanceClockSchema = z.object({ ms: z.number().int().positive() });
