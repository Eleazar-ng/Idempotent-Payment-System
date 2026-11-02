import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { clearWebhookEndpoint, DB, getWebhookEndpoint, rotateWebhookSecret, setWebhookEndpoint } from '@app/db';
import type { Database } from '@app/db';
import { checkWebhookUrl, generateWebhookSecret, resolveAllowedAddress, UnsafeUrlError } from '@app/payments-core';
import type { Resolver, UrlPolicy } from '@app/payments-core';
import { AuthService } from './auth.service';
import { problem } from './payment-http';
import type { HttpResult } from './payment-http';

export const WEBHOOK_URL_OPTIONS = Symbol('WEBHOOK_URL_OPTIONS');

export interface WebhookUrlOptions {
  policy: UrlPolicy;
  /** Injected so tests control DNS. */
  resolver?: Resolver;
}

const setEndpointSchema = z.object({ url: z.string().min(1).max(2048) }).strict();

/**
 * A merchant's webhook endpoint (Stage 11): the URL we send events to and the secret we sign them with.
 *
 * Registration refuses a URL the delivery policy would refuse (https only, no credentials, no internal names or addresses, and the
 * name must RESOLVE to public addresses), so a merchant finds out now rather than from a dead event later. This is advice, not the
 * guard: the relay applies the same policy again at every delivery, against the address it actually connects to.
 *
 * The signing secret is shown once, when it is made (first registration or rotation) and never returned again.
 */
@Injectable()
export class WebhookEndpointService {
  private readonly logger = new Logger(WebhookEndpointService.name);

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(WEBHOOK_URL_OPTIONS) private readonly options: WebhookUrlOptions,
    private readonly auth: AuthService,
  ) {
    if (options.policy.allowHttp || options.policy.allowPrivateNetworks) {
      this.logger.warn(
        `webhook URLs are being accepted under a RELAXED policy (allowHttp=${options.policy.allowHttp}, allowPrivateNetworks=${options.policy.allowPrivateNetworks}). Local development only.`,
      );
    }
  }

  async get(authorization: unknown): Promise<HttpResult> {
    const auth = await this.auth.authenticate(authorization);
    if (!('merchantId' in auth)) return auth;
    const endpoint = await getWebhookEndpoint(this.db, auth.merchantId);
    return endpoint ? ok(200, { object: 'webhook_endpoint', url: endpoint.url }) : notConfigured();
  }

  async set(authorization: unknown, body: unknown): Promise<HttpResult> {
    const auth = await this.auth.authenticate(authorization);
    if (!('merchantId' in auth)) return auth;

    const parsed = setEndpointSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return problem(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
    }

    let url: URL;
    try {
      url = checkWebhookUrl(parsed.data.url, this.options.policy);
      await resolveAllowedAddress(url, this.options.policy, this.options.resolver);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        return problem(422, 'invalid_webhook_url', error.message, { reason: error.reason });
      }
      // The name did not resolve at all (or DNS failed). Not accepted: we could not tell where it points.
      return problem(422, 'webhook_host_unresolvable', 'The host name could not be resolved. Check the spelling, and that its DNS record exists.');
    }

    const secret = generateWebhookSecret();
    const result = await setWebhookEndpoint(this.db, auth.merchantId, url.href, secret);
    if (!result) return problem(401, 'invalid_api_key', 'The API key is not valid.');
    this.logger.log(`merchant ${auth.merchantId} ${result.created ? 'registered' : 'changed'} its webhook endpoint (host ${url.host})`);
    return result.created
      ? ok(201, { object: 'webhook_endpoint', url: url.href, secret, secret_note: 'Store this secret now. It is not shown again.' })
      : ok(200, { object: 'webhook_endpoint', url: url.href });
  }

  async rotateSecret(authorization: unknown): Promise<HttpResult> {
    const auth = await this.auth.authenticate(authorization);
    if (!('merchantId' in auth)) return auth;
    const secret = generateWebhookSecret();
    if (!(await rotateWebhookSecret(this.db, auth.merchantId, secret))) return notConfigured();
    this.logger.log(`merchant ${auth.merchantId} rotated its webhook secret`);
    return ok(200, { object: 'webhook_endpoint', secret, secret_note: 'Store this secret now. It is not shown again. Events are signed with it from now on.' });
  }

  async remove(authorization: unknown): Promise<HttpResult> {
    const auth = await this.auth.authenticate(authorization);
    if (!('merchantId' in auth)) return auth;
    await clearWebhookEndpoint(this.db, auth.merchantId);
    this.logger.log(`merchant ${auth.merchantId} removed its webhook endpoint`);
    return { status: 204, body: undefined, headers: {} };
  }
}

const ok = (status: number, body: Record<string, unknown>): HttpResult => ({ status, body, headers: {} });
const notConfigured = (): HttpResult => problem(404, 'webhook_endpoint_not_configured', 'No webhook endpoint is set for this merchant.');
