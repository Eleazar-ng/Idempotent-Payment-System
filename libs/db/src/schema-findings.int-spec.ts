import { expectSqlState, PG, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';

describe('0009 reconciliation_findings schema', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const insert = (over: Record<string, unknown> = {}) =>
    pg.db
      .insertInto('reconciliation_findings')
      .values({ dedupe_key: `k_${uid()}`, kind: 'orphan_charge', source: 'reconciliation', detail: 'x', ...over })
      .returning(['id', 'dedupe_key'])
      .executeTakeFirstOrThrow();
  const update = (id: number, set: Record<string, unknown>) =>
    pg.db.updateTable('reconciliation_findings').set(set).where('id', '=', id).execute();

  it('refuses the same dedupe key twice', async () => {
    const a = await insert();
    await expectSqlState(insert({ dedupe_key: a.dedupe_key }), PG.UNIQUE_VIOLATION);
  });

  it('refuses an unknown source, status, empty detail and non-positive count', async () => {
    await expectSqlState(insert({ source: 'guess' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ status: 'closed' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ detail: '' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ seen_count: 0 }), PG.CHECK_VIOLATION);
  });

  it('refuses an unknown attempt', async () => {
    await expectSqlState(insert({ attempt_id: 987_654_321 }), PG.FOREIGN_KEY_VIOLATION);
  });

  it('resolved needs both a time and a reason, and open has neither', async () => {
    const a = await insert();
    await expectSqlState(update(a.id, { status: 'resolved' }), PG.CHECK_VIOLATION);
    await expectSqlState(update(a.id, { status: 'resolved', resolved_at: new Date() }), PG.CHECK_VIOLATION);
    await expectSqlState(update(a.id, { resolution: 'because' }), PG.CHECK_VIOLATION);
    await update(a.id, { status: 'resolved', resolved_at: new Date(), resolution: 'refunded' });
  });

  it.each(['dedupe_key', 'kind', 'source', 'charge_id'])('what was found never changes: %s', async (column) => {
    const a = await insert({ charge_id: 'ch_1' });
    await expectSqlState(update(a.id, { [column]: column === 'source' ? 'webhook' : 'changed' }), PG.IMMUTABLE_COLUMN);
  });

  it('status, counters and detail may change', async () => {
    const a = await insert();
    await update(a.id, { seen_count: 2, detail: 'updated', last_seen_at: new Date() });
  });
});
