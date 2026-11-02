import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { authenticateApiKey, DB } from '@app/db';
import type { Database } from '@app/db';
import { extractBearer } from '@app/payments-core';
import { METRICS } from '@app/observability';
import type { AppMetrics } from '@app/observability';
import { problem } from './payment-http';
import type { HttpResult } from './payment-http';

const CHALLENGE = { 'WWW-Authenticate': 'Bearer realm="payments"' };

/**
 * Who is calling (Stage 11). The caller sends `Authorization: Bearer <api key>`; the merchant is whoever the key belongs to.
 * Nothing else names a merchant any more: a header the caller writes cannot say who the caller is.
 *
 * Every failure is the same 401 with the same body, whatever the cause (no header, malformed, unknown, wrong secret, revoked,
 * expired). The cause goes to the log (with the key's public prefix, never the key) and to a metric, not to the caller.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(METRICS) private readonly metrics: AppMetrics,
  ) {}

  async authenticate(authorization: unknown): Promise<{ merchantId: number } | HttpResult> {
    const token = extractBearer(authorization);
    if (token === undefined) {
      this.metrics.authAttempts.inc({ result: 'missing' });
      return problem(401, 'authentication_required', 'Send your API key as "Authorization: Bearer <key>".', {}, CHALLENGE);
    }

    const result = await authenticateApiKey(this.db, token);
    if (!result.ok) {
      this.metrics.authAttempts.inc({ result: 'invalid' });
      this.logger.warn(`api key rejected: ${result.reason}${result.prefix ? ` (prefix ${result.prefix})` : ''}`);
      return problem(401, 'invalid_api_key', 'The API key is not valid.', {}, CHALLENGE);
    }
    this.metrics.authAttempts.inc({ result: 'ok' });
    return { merchantId: result.merchantId };
  }
}
