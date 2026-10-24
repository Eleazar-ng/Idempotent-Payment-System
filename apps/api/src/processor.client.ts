import { Inject, Injectable } from '@nestjs/common';
import { classifyChargeResponse } from '@app/payments-core';
import type { ProcessorOutcome } from '@app/payments-core';

export const PROCESSOR_CLIENT_OPTIONS = Symbol('PROCESSOR_CLIENT_OPTIONS');

export interface ProcessorClientOptions {
  baseUrl: string;
  /** Give up waiting after this long. The result is `unknown`, never `failed`. */
  timeoutMs: number;
}

export interface ChargeRequest {
  /** The attempt's processor idempotency key, read from the database, identical on every retry. */
  idempotencyKey: string;
  amount: number;
  currency: string;
  source: string;
  metadata: Record<string, string>;
}

/**
 * Calls the processor's charge endpoint and says what the answer MEANS (Module 2.3).
 *
 * It never throws and never guesses: a timeout, a reset connection, a half-read body or a malformed
 * answer all become `unknown`, the one outcome that forbids failing the attempt, because in every
 * one of those cases the money may already have moved.
 */
@Injectable()
export class ProcessorClient {
  constructor(@Inject(PROCESSOR_CLIENT_OPTIONS) private readonly options: ProcessorClientOptions) {}

  async charge(request: ChargeRequest): Promise<ProcessorOutcome> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/charges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey },
        body: JSON.stringify({
          amount: request.amount,
          currency: request.currency,
          source: request.source,
          metadata: request.metadata,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      // Reading the body can fail too (connection cut mid-response), and that is still "unknown".
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      return classifyChargeResponse(response.status, body);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { kind: 'unknown', reason: timedOut ? 'timeout' : 'network_error' };
    }
  }
}
