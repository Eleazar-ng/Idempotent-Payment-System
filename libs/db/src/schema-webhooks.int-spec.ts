import { createAttemptInStatus, expectSqlState, PG, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';

describe('0007 webhook_events', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const insert = (over: Record<string, unknown> = {}) =>
    pg.db
      .insertInto('webhook_events')
      .values({
        source: 'processor',
        event_id: `evt_${uid()}`,
        event_type: 'charge.succeeded',
        payload: JSON.stringify({ a: 1 }),
        ...over,
      })
      .returning(['id', 'event_id'])
      .executeTakeFirstOrThrow();

  const handle = (id: number, set: Record<string, unknown>) =>
    pg.db.updateTable('webhook_events').set({ processed_at: new Date(), ...set }).where('id', '=', id).execute();

  it('refuses the same event id from the same source twice', async () => {
    const first = await insert();
    await expectSqlState(insert({ event_id: first.event_id }), PG.UNIQUE_VIOLATION);
  });

  it('allows the same event id from a different source', async () => {
    const first = await insert();
    await insert({ event_id: first.event_id, source: 'another' });
  });

  it('starts as received, with no processed time', async () => {
    const { id } = await insert();
    const row = await pg.db.selectFrom('webhook_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.result).toBe('received');
    expect(row.processed_at).toBeNull();
  });

  it('refuses a result outside the known list', async () => {
    await expectSqlState(insert({ result: 'maybe' }), PG.CHECK_VIOLATION);
  });

  it('refuses a processed time without a verdict, and a verdict without a processed time', async () => {
    const a = await insert();
    await expectSqlState(handle(a.id, {}), PG.CHECK_VIOLATION); // processed_at set, result still received
    const b = await insert();
    await expectSqlState(
      pg.db.updateTable('webhook_events').set({ result: 'ignored' }).where('id', '=', b.id).execute(),
      PG.CHECK_VIOLATION,
    );
  });

  it('an applied event must name its attempt', async () => {
    const a = await insert();
    await expectSqlState(handle(a.id, { result: 'applied' }), PG.CHECK_VIOLATION);
    const b = await insert();
    await expectSqlState(handle(b.id, { result: 'already_applied' }), PG.CHECK_VIOLATION);

    const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
    const c = await insert();
    await handle(c.id, { result: 'applied', attempt_id: attemptId });
  });

  it('refuses to point at an attempt that does not exist', async () => {
    const a = await insert();
    await expectSqlState(handle(a.id, { result: 'conflict', attempt_id: 987_654_321 }), PG.FOREIGN_KEY_VIOLATION);
  });

  it.each(['source', 'event_id', 'event_type'])('what was received never changes: %s', async (column) => {
    const { id } = await insert();
    await expectSqlState(
      pg.db.updateTable('webhook_events').set({ [column]: 'changed' }).where('id', '=', id).execute(),
      PG.IMMUTABLE_COLUMN,
    );
  });

  it('the stored payload never changes', async () => {
    const { id } = await insert();
    await expectSqlState(
      pg.db.updateTable('webhook_events').set({ payload: JSON.stringify({ a: 2 }) }).where('id', '=', id).execute(),
      PG.IMMUTABLE_COLUMN,
    );
  });

  it('is frozen once handled', async () => {
    const { id } = await insert();
    await handle(id, { result: 'ignored' });
    await expectSqlState(handle(id, { result: 'conflict' }), PG.APPEND_ONLY);
  });

  it('can be deleted, so retention cleanup works', async () => {
    const { id } = await insert();
    await handle(id, { result: 'ignored' });
    await pg.db.deleteFrom('webhook_events').where('id', '=', id).execute();
  });
});
