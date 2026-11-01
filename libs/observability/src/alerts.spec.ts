import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMetrics } from './metrics';

/**
 * docs/alerts.yml is only worth having if it can never point at a metric that no longer exists. This reads
 * every `expr:` line and checks each metric name in it against the real registry.
 */
const FILE = readFileSync(join(__dirname, '../../../docs/alerts.yml'), 'utf8');
const PROMQL_WORDS = new Set(['histogram_quantile']);

function metricNamesIn(expr: string): string[] {
  const stripped = expr
    .replace(/\{[^}]*\}/g, '') // label matchers
    .replace(/\[[^\]]*\]/g, '') // range selectors
    .replace(/"[^"]*"/g, '');
  return [...stripped.matchAll(/[a-z][a-z0-9_]*/g)].map((m) => m[0]).filter((w) => w.includes('_') && !PROMQL_WORDS.has(w));
}

describe('docs/alerts.yml', () => {
  const exprs = FILE.split('\n')
    .map((l) => /^\s*expr:\s*(.+)$/.exec(l)?.[1])
    .filter((e): e is string => e !== undefined);
  const registered = createMetrics().registry.getMetricsAsArray().map((m) => (m as unknown as { name: string }).name);
  // histograms expose name_bucket / name_count / name_sum
  const known = new Set(registered.flatMap((n) => [n, `${n}_bucket`, `${n}_count`, `${n}_sum`]));

  it('has alerts, each with an expr, a severity and a runbook link', () => {
    const alerts = (FILE.match(/- alert: /g) ?? []).length;
    expect(alerts).toBeGreaterThanOrEqual(15);
    expect(exprs).toHaveLength(alerts);
    expect((FILE.match(/severity: (critical|warning)/g) ?? []).length).toBe(alerts);
    expect((FILE.match(/runbook: docs\/observability\.md#/g) ?? []).length).toBe(alerts);
  });

  it.each(exprs.map((e) => [e]))('only uses metrics that exist: %s', (expr) => {
    const names = metricNamesIn(expr);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(known).toContain(name);
  });

  it('every runbook anchor exists in docs/observability.md', () => {
    const doc = readFileSync(join(__dirname, '../../../docs/observability.md'), 'utf8');
    const headings = new Set(
      [...doc.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')),
    );
    for (const m of FILE.matchAll(/runbook: docs\/observability\.md#(\S+)/g)) expect(headings).toContain(m[1]);
  });
});
