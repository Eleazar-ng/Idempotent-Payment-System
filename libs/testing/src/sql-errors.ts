/**
 * SQLSTATE codes the schema raises on purpose. See the header of
 * libs/db/migrations/0001_core_tables.sql for what each one means.
 */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  INVALID_TRANSITION: 'PY001',
  IMMUTABLE_COLUMN: 'PY002',
  APPEND_ONLY: 'PY003',
  INTEGRITY: 'PY004',
  UNBALANCED_LEDGER: 'PY005',
} as const;

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Asserts that a database operation is refused with the given SQLSTATE.
 * Passing a success is a test failure, as is failing with a different error: a "rejected"
 * result that is really a typo in the test SQL must not be mistaken for the guard working.
 */
export async function expectSqlState(
  operation: PromiseLike<unknown>,
  code: string,
  messagePattern?: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`Expected the database to refuse with SQLSTATE ${code}, but the statement succeeded`);
  }

  const actual = sqlStateOf(caught);
  if (actual !== code) {
    throw new Error(
      `Expected SQLSTATE ${code} but got ${actual ?? '(no code)'}: ${messageOf(caught)}`,
    );
  }
  if (messagePattern && !messagePattern.test(messageOf(caught))) {
    throw new Error(`SQLSTATE ${code} matched, but message "${messageOf(caught)}" did not match ${messagePattern}`);
  }
}
