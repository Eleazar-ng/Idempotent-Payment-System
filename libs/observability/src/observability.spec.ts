import { JsonLogger, parseLogLevel } from './json-logger';
import { routeLabel } from './http-metrics';
import { createMetrics } from './metrics';
import { redact, REDACTED, scrubText } from './redact';
import { currentRequestId, requestIdFrom, runWithRequestId } from './request-context';

function capture(options: ConstructorParameters<typeof JsonLogger>[0] = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({ now: () => new Date('2030-01-01T00:00:00Z'), ...options, write: (l) => lines.push(JSON.parse(l)) });
  return { logger, lines };
}

describe('redact', () => {
  it('hides sensitive keys at any depth, by name', () => {
    expect(redact({ ok: 1, webhook_secret: 'abc', nested: { Authorization: 'Bearer x', source: 'tok_visa', deep: [{ apiKey: 'k' }] } })).toEqual({
      ok: 1,
      webhook_secret: REDACTED,
      nested: { Authorization: REDACTED, source: REDACTED, deep: [{ apiKey: REDACTED }] },
    });
  });

  it('scrubs bearer tokens and signature values inside free text', () => {
    expect(scrubText('sent Bearer abc.def-123 and t=1,v1=0123456789abcdef0123456789abcdef')).toBe(`sent Bearer ${REDACTED} and t=1,v1=${REDACTED}`);
  });

  it('survives cycles and very deep objects', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe('JsonLogger', () => {
  it('writes one JSON object per line with level, context and message', () => {
    const { logger, lines } = capture({ service: 'api' });
    logger.log('hello', 'PaymentsService');
    expect(lines).toEqual([{ time: '2030-01-01T00:00:00.000Z', level: 'info', service: 'api', context: 'PaymentsService', message: 'hello' }]);
  });

  it('adds the request id while a request is being handled, and not outside it', () => {
    const { logger, lines } = capture();
    runWithRequestId('req-1', () => logger.warn('inside'));
    logger.warn('outside');
    expect(lines[0]).toMatchObject({ requestId: 'req-1', level: 'warn' });
    expect(lines[1]).not.toHaveProperty('requestId');
  });

  it('never writes a secret, whether in an object, an error or a string', () => {
    const { logger, lines } = capture();
    logger.log({ message: 'delivery', webhook_secret: 'topsecretvalue1234' });
    logger.error(new Error('failed with Bearer abc123xyz'));
    logger.error('boom', 'stack with v1=0123456789abcdef0123456789abcdef', 'Ctx');
    const text = JSON.stringify(lines);
    expect(text).not.toContain('topsecretvalue1234');
    expect(text).not.toContain('abc123xyz');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('d');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('a message object cannot overwrite the level or time', () => {
    const { logger, lines } = capture();
    logger.log({ level: 'debug', time: 'yesterday', event: 'x' });
    expect(lines[0]).toMatchObject({ level: 'info', time: '2030-01-01T00:00:00.000Z', event: 'x' });
  });

  it('parses levels, defaulting to info', () => {
    expect(['debug', 'warn', 'error', 'info', undefined, 'nonsense'].map((v) => parseLogLevel(v))).toEqual(['debug', 'warn', 'error', 'log', 'log', 'log']);
  });
});

describe('request ids', () => {
  it('keeps a plain caller id and replaces anything else', () => {
    expect(requestIdFrom('abc-123_X.y:z')).toBe('abc-123_X.y:z');
    for (const hostile of ['has space', 'new\nline', 'x'.repeat(65), '', undefined, ['a']]) {
      const id = requestIdFrom(hostile);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('is visible to code called from inside the request, including after awaits', async () => {
    await runWithRequestId('req-9', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentRequestId()).toBe('req-9');
    });
    expect(currentRequestId()).toBeUndefined();
  });
});

describe('routeLabel', () => {
  it('uses the route pattern, never the url', () => {
    expect(routeLabel({ baseUrl: '', route: { path: '/v1/payments/:id' } } as never)).toBe('/v1/payments/:id');
    expect(routeLabel({ baseUrl: '/v1', route: { path: '/payments' } } as never)).toBe('/v1/payments');
  });
  it('collapses requests that matched nothing into one label', () => {
    expect(routeLabel({ baseUrl: '', route: undefined } as never)).toBe('unmatched');
  });
});

describe('metrics', () => {
  it('exposes every metric under its documented name', async () => {
    const text = await createMetrics().registry.metrics();
    for (const name of [
      'http_requests_total',
      'http_request_duration_seconds',
      'idempotency_claims_total',
      'payment_outcomes_total',
      'processor_calls_total',
      'processor_call_duration_seconds',
      'webhook_events_total',
      'outbox_deliveries_total',
      'recovery_actions_total',
      'recovery_runs_total',
      'reconciliation_findings_recorded_total',
      'outbox_events',
      'outbox_oldest_due_age_seconds',
      'payment_attempts_in_state',
      'payment_attempts_oldest_idle_seconds',
      'reconciliation_findings_open',
      'attempts_missing_outbox_event',
      'ledger_invariant_violations',
      'stats_scrape_errors_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it('has no label that could carry an identifier', () => {
    const metrics = createMetrics();
    const forbidden = /merchant|order|attempt_id|charge|key|payment_id|intent|error|message/;
    const labels = Object.values(metrics)
      .filter((m): m is { labelNames: string[] } => typeof m === 'object' && m !== null && 'labelNames' in m)
      .flatMap((m) => m.labelNames);
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(label).not.toMatch(forbidden);
  });

  it('keeps registries apart, so two apps in one test process do not share counts', async () => {
    const a = createMetrics();
    const b = createMetrics();
    a.paymentOutcomes.inc({ result: 'succeeded' });
    expect(await b.registry.metrics()).not.toContain('payment_outcomes_total{result="succeeded"}');
  });
});
