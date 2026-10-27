import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DB, handleWebhookEvent } from '@app/db';
import type { Database } from '@app/db';
import { parseWebhookEvent, verifyWebhook, WebhookPayloadError, WebhookSignatureError } from '@app/payments-core';
import { problem } from './payment-http';
import type { HttpResult } from './payment-http';

export const WEBHOOK_OPTIONS = Symbol('WEBHOOK_OPTIONS');

export interface WebhookOptions {
  /** One secret, or several while one is being rotated. */
  secret: string | readonly string[];
  feeBps: number;
  /** How far a signed timestamp may be from now. Defaults to the library's 5 minutes. */
  toleranceSeconds?: number;
}

/** The name this processor goes by in `webhook_events.source`. */
export const PROCESSOR_SOURCE = 'processor';

/**
 * Receives processor webhooks (Stage 7).
 *
 *   1. verify the signature against the RAW bytes   -> 400 if it does not hold (nothing is stored)
 *   2. understand the body                           -> 400 if it cannot be (a resend would not help)
 *   3. handle the event exactly once, atomically     -> 200 whatever it decided; 5xx only if handling
 *                                                       itself failed, so the processor sends it again
 *
 * A 2xx means "I have this, stop sending it". It is returned for duplicates and for events we
 * recorded but chose not to apply (conflicts, mismatches), because resending cannot change those.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(WEBHOOK_OPTIONS) private readonly options: WebhookOptions,
  ) {}

  async receive(input: { rawBody: Buffer | undefined; signature: string | undefined }): Promise<HttpResult> {
    if (!input.rawBody) {
      // rawBody is switched on in bootstrap.ts. If it is missing, every signature would fail
      // for a reason that looks like an attack; say what it really is.
      this.logger.error('webhook received without raw body: is NEST_APP_OPTIONS.rawBody enabled?');
      return problem(400, 'raw_body_unavailable', 'The request body could not be read as raw bytes.');
    }

    try {
      verifyWebhook({
        secret: this.options.secret,
        header: input.signature,
        payload: input.rawBody,
        toleranceSeconds: this.options.toleranceSeconds,
      });
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        this.logger.warn(`webhook rejected: ${error.reason}`);
        return problem(400, 'invalid_signature', 'The webhook signature could not be verified.');
      }
      throw error;
    }

    let parsed: ReturnType<typeof parseWebhookEvent>;
    try {
      parsed = parseWebhookEvent(input.rawBody);
    } catch (error) {
      if (error instanceof WebhookPayloadError) {
        this.logger.warn(`webhook with a valid signature but unusable body: ${error.message}`);
        return problem(400, 'invalid_payload', error.message);
      }
      throw error;
    }

    const result = await handleWebhookEvent(this.db, {
      source: PROCESSOR_SOURCE,
      event: parsed.event,
      payload: parsed.payload,
      feeBps: this.options.feeBps,
    });

    if (!result.duplicate && ['conflict', 'mismatch', 'unmatched'].includes(result.result)) {
      this.logger.error(
        `webhook ${parsed.event.eventId} recorded as ${result.result}: ${result.detail ?? ''} (needs reconciliation)`,
      );
    }
    return {
      status: 200,
      body: { received: true, duplicate: result.duplicate, result: result.result },
      headers: {},
    };
  }
}
