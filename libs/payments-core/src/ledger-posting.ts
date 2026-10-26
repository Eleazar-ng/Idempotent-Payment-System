/**
 * Pure double-entry posting rules (Module 8). No database here: this file decides WHAT the books
 * should say, the database layer decides how to write it, and the database itself refuses anything
 * that does not add up.
 */

export type LedgerDirection = 'debit' | 'credit';
export type LedgerAccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountSpec {
  code: string;
  kind: LedgerAccountKind;
  currency: string;
}

export interface PostingEntry {
  account: AccountSpec;
  direction: LedgerDirection;
  /** Integer minor units, always positive. Direction carries the sign. */
  amount: number;
}

export interface Posting {
  /** One business event, one key. Posting it twice is a no-op, never a second set of entries. */
  postingKey: string;
  sourceType: 'payment_attempt';
  sourceId: number;
  entries: PostingEntry[];
}

/** The key under which an attempt's success is booked. Every code path derives it the same way. */
export function attemptSuccessPostingKey(attemptId: number): string {
  return `attempt:${attemptId}:succeeded`;
}

// Account codes include the currency, so an account can never silently mix two currencies.
export const processorReceivableAccount = (currency: string): AccountSpec => ({
  code: `processor_receivable:${currency}`,
  kind: 'asset',
  currency,
});

export const merchantPayableAccount = (merchantId: number, currency: string): AccountSpec => ({
  code: `merchant_payable:${merchantId}:${currency}`,
  kind: 'liability',
  currency,
});

export const platformFeeRevenueAccount = (currency: string): AccountSpec => ({
  code: `platform_fee_revenue:${currency}`,
  kind: 'revenue',
  currency,
});

/**
 * The platform's fee on a payment: `bps` basis points of the amount (1 bps = 0.01%), rounded half up
 * to a whole minor unit. Integer arithmetic only (BigInt for the intermediate product, so a large
 * amount cannot overflow a double): floats and money do not mix.
 */
export function computeFee(amount: number, feeBps: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError('amount must be a positive safe integer');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError('feeBps must be an integer from 0 to 10000');
  }
  return Number((BigInt(amount) * BigInt(feeBps) + 5_000n) / 10_000n);
}

export interface AttemptSuccessInput {
  attemptId: number;
  merchantId: number;
  amount: number;
  currency: string;
  feeBps: number;
}

/**
 * How a successful payment is booked:
 *
 *   DR processor_receivable   amount          the processor now owes us this money
 *   CR merchant_payable       amount - fee    we now owe the merchant their share
 *   CR platform_fee_revenue   fee             what we keep
 *
 * Debits always equal credits by construction (and `assertBalanced` proves it, so a future edit
 * cannot quietly break it). Zero-value lines are left out because the ledger only stores positive
 * amounts: with a 0 fee there is no fee line, and a 100% fee leaves nothing for the merchant.
 */
export function buildAttemptSuccessPosting(input: AttemptSuccessInput): Posting {
  const fee = computeFee(input.amount, input.feeBps);
  const net = input.amount - fee;

  const entries: PostingEntry[] = [
    { account: processorReceivableAccount(input.currency), direction: 'debit', amount: input.amount },
    { account: merchantPayableAccount(input.merchantId, input.currency), direction: 'credit', amount: net },
    { account: platformFeeRevenueAccount(input.currency), direction: 'credit', amount: fee },
  ].filter((entry) => entry.amount > 0) as PostingEntry[];

  const posting: Posting = {
    postingKey: attemptSuccessPostingKey(input.attemptId),
    sourceType: 'payment_attempt',
    sourceId: input.attemptId,
    entries,
  };
  assertBalanced(posting);
  return posting;
}

/** Throws unless every currency's debits equal its credits and every amount is a positive integer. */
export function assertBalanced(posting: Posting): void {
  if (posting.entries.length < 2) throw new Error('a posting needs at least two entries');

  const net = new Map<string, number>();
  for (const { account, direction, amount } of posting.entries) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new RangeError(`entry amount must be a positive safe integer, got ${amount}`);
    }
    net.set(account.currency, (net.get(account.currency) ?? 0) + (direction === 'debit' ? amount : -amount));
  }
  for (const [currency, difference] of net) {
    if (difference !== 0) {
      throw new Error(`posting ${posting.postingKey} does not balance in ${currency}: debits minus credits = ${difference}`);
    }
  }
}
