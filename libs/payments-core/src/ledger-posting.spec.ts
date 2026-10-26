import {
  assertBalanced,
  attemptSuccessPostingKey,
  buildAttemptSuccessPosting,
  computeFee,
  merchantPayableAccount,
} from './ledger-posting';
import type { Posting } from './ledger-posting';

describe('computeFee', () => {
  it.each([
    [10_000, 150, 150], // 1.5% of 100.00
    [5_000, 150, 75],
    [999, 150, 15], // 14.985 rounds up to 15
    [1_000, 150, 15], // 15.0 exactly
    [333, 150, 5], // 4.995 rounds up to 5
    [100, 49, 0], // 0.49 rounds down to 0
    [100, 50, 1], // 0.50 rounds half UP to 1
    [1, 5_000, 1], // 0.5 rounds up
    [12_345, 0, 0],
    [12_345, 10_000, 12_345],
  ])('fee on %i at %i bps is %i', (amount, bps, expected) => {
    expect(computeFee(amount, bps)).toBe(expected);
  });

  it('never overflows on very large amounts (BigInt intermediate)', () => {
    const big = Number.MAX_SAFE_INTEGER; // 9007199254740991
    expect(computeFee(big, 10_000)).toBe(big);
    expect(computeFee(big, 1)).toBe(900719925474); // 900719925474.0991 rounds down
  });

  it('is never more than the amount, never negative, for a sweep of inputs', () => {
    for (const amount of [1, 2, 3, 7, 99, 100, 101, 12_345, 1_000_000_007]) {
      for (const bps of [0, 1, 49, 50, 99, 150, 2_500, 9_999, 10_000]) {
        const fee = computeFee(amount, bps);
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(amount);
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('refuses amount %p', (amount) => {
    expect(() => computeFee(amount, 100)).toThrow(RangeError);
  });

  it.each([-1, 10_001, 1.5, Number.NaN])('refuses feeBps %p', (bps) => {
    expect(() => computeFee(100, bps)).toThrow(RangeError);
  });
});

describe('buildAttemptSuccessPosting', () => {
  const base = { attemptId: 7, merchantId: 3, amount: 5_000, currency: 'NGN', feeBps: 150 };

  it('books the receivable, the merchant’s share and the fee', () => {
    const posting = buildAttemptSuccessPosting(base);

    expect(posting.postingKey).toBe('attempt:7:succeeded');
    expect(posting).toMatchObject({ sourceType: 'payment_attempt', sourceId: 7 });
    expect(posting.entries.map((e) => [e.account.code, e.account.kind, e.direction, e.amount])).toEqual([
      ['processor_receivable:NGN', 'asset', 'debit', 5_000],
      ['merchant_payable:3:NGN', 'liability', 'credit', 4_925],
      ['platform_fee_revenue:NGN', 'revenue', 'credit', 75],
    ]);
  });

  it('with no fee there is no fee line: two entries, merchant gets everything', () => {
    const posting = buildAttemptSuccessPosting({ ...base, feeBps: 0 });
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries[1]).toMatchObject({ direction: 'credit', amount: 5_000 });
  });

  it('with a 100% fee there is no merchant line', () => {
    const posting = buildAttemptSuccessPosting({ ...base, feeBps: 10_000 });
    expect(posting.entries.map((e) => e.account.code)).toEqual(['processor_receivable:NGN', 'platform_fee_revenue:NGN']);
  });

  it('always balances, whatever the amount and fee (the money is conserved)', () => {
    for (const amount of [1, 2, 3, 99, 100, 101, 999, 12_345, 1_000_000_007, Number.MAX_SAFE_INTEGER]) {
      for (const feeBps of [0, 1, 50, 150, 333, 5_000, 9_999, 10_000]) {
        const posting = buildAttemptSuccessPosting({ ...base, amount, feeBps });
        const credits = posting.entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount, 0);
        const debits = posting.entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + e.amount, 0);
        expect(debits).toBe(amount);
        expect(credits).toBe(amount);
        expect(posting.entries.every((e) => e.amount > 0)).toBe(true);
      }
    }
  });

  it('keeps each currency in its own accounts, and each merchant in their own payable account', () => {
    const ngn = buildAttemptSuccessPosting(base).entries.map((e) => e.account.code);
    const usd = buildAttemptSuccessPosting({ ...base, currency: 'USD' }).entries.map((e) => e.account.code);
    const other = buildAttemptSuccessPosting({ ...base, merchantId: 4 }).entries.map((e) => e.account.code);

    expect(ngn.filter((c) => usd.includes(c))).toEqual([]);
    expect(other).not.toContain('merchant_payable:3:NGN');
    expect(other).toContain('merchant_payable:4:NGN');
  });

  it('uses the same key for the same attempt on every path', () => {
    expect(attemptSuccessPostingKey(7)).toBe(buildAttemptSuccessPosting(base).postingKey);
    expect(buildAttemptSuccessPosting({ ...base, amount: 1 }).postingKey).toBe('attempt:7:succeeded');
    expect(attemptSuccessPostingKey(8)).not.toBe(attemptSuccessPostingKey(7));
  });
});

describe('assertBalanced', () => {
  const account = merchantPayableAccount(1, 'NGN');
  const make = (entries: Posting['entries']): Posting => ({ postingKey: 'k', sourceType: 'payment_attempt', sourceId: 1, entries });

  it('accepts a balanced posting', () => {
    expect(() =>
      assertBalanced(make([{ account, direction: 'debit', amount: 5 }, { account, direction: 'credit', amount: 5 }])),
    ).not.toThrow();
  });

  it.each([
    ['debits above credits', [{ direction: 'debit', amount: 6 }, { direction: 'credit', amount: 5 }]],
    ['credits above debits', [{ direction: 'debit', amount: 5 }, { direction: 'credit', amount: 6 }]],
    ['a single entry', [{ direction: 'debit', amount: 5 }]],
    ['a zero amount', [{ direction: 'debit', amount: 0 }, { direction: 'credit', amount: 0 }]],
    ['a fractional amount', [{ direction: 'debit', amount: 0.5 }, { direction: 'credit', amount: 0.5 }]],
    ['a negative amount', [{ direction: 'debit', amount: -5 }, { direction: 'credit', amount: -5 }]],
  ] as const)('refuses %s', (_name, lines) => {
    expect(() => assertBalanced(make(lines.map((l) => ({ account, ...l })) as Posting['entries']))).toThrow();
  });

  it('balances per currency: 5 NGN of debit does not offset 5 USD of credit', () => {
    const usd = merchantPayableAccount(1, 'USD');
    expect(() =>
      assertBalanced(make([{ account, direction: 'debit', amount: 5 }, { account: usd, direction: 'credit', amount: 5 }])),
    ).toThrow(/does not balance in (NGN|USD)/);
  });
});
