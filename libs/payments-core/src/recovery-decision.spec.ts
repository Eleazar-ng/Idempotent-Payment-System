import { attemptMachine } from './payment-states';
import type { AttemptStatus } from './payment-states';
import { decideRecovery } from './recovery-decision';
import type { AttemptSnapshot, ChargeSnapshot, ChargeStatus, RecoveryDecision, RecoveryPolicy } from './recovery-decision';

const policy: RecoveryPolicy = { stuckAfterMs: 120_000, abandonedGraceMs: 90_000_000 };

const attempt = (status: AttemptStatus, over: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  status,
  chargeId: status === 'calling_processor' || status === 'created' ? null : 'ch_1',
  amount: 5000,
  currency: 'NGN',
  idleMs: 10 * 60_000,
  ageMs: 10 * 60_000,
  ...over,
});
const charge = (status: ChargeStatus, over: Partial<ChargeSnapshot> = {}): ChargeSnapshot => ({
  id: 'ch_1',
  status,
  amount: 5000,
  currency: 'NGN',
  failureCode: status === 'failed' ? 'insufficient_funds' : null,
  ...over,
});
const decide = (a: AttemptSnapshot, c: ChargeSnapshot | null) => decideRecovery(a, c, policy);

describe('decideRecovery: the processor knows the charge', () => {
  type Row = [AttemptStatus, ChargeStatus, Partial<RecoveryDecision>];
  const rows: Row[] = [
    // the processor says succeeded
    ['calling_processor', 'succeeded', { action: 'apply', outcome: { kind: 'succeeded', chargeId: 'ch_1' } }],
    ['processing', 'succeeded', { action: 'apply', outcome: { kind: 'succeeded', chargeId: 'ch_1' } }],
    ['requires_action', 'succeeded', { action: 'apply', outcome: { kind: 'succeeded', chargeId: 'ch_1' } }],
    ['abandoned', 'succeeded', { action: 'apply', outcome: { kind: 'succeeded', chargeId: 'ch_1' } }],
    ['succeeded', 'succeeded', { action: 'none' }],
    ['failed', 'succeeded', { action: 'finding', kind: 'paid_but_failed' }],
    // the processor says failed
    ['calling_processor', 'failed', { action: 'apply', outcome: { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_1' } }],
    ['processing', 'failed', { action: 'apply', outcome: { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_1' } }],
    ['requires_action', 'failed', { action: 'apply', outcome: { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_1' } }],
    ['abandoned', 'failed', { action: 'apply', outcome: { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_1' } }],
    ['failed', 'failed', { action: 'none' }],
    ['succeeded', 'failed', { action: 'finding', kind: 'succeeded_but_charge_not_succeeded' }],
    // pending
    ['calling_processor', 'pending', { action: 'apply', outcome: { kind: 'processing', chargeId: 'ch_1' } }],
    ['requires_action', 'pending', { action: 'apply', outcome: { kind: 'processing', chargeId: 'ch_1' } }],
    ['processing', 'pending', { action: 'wait' }],
    ['abandoned', 'pending', { action: 'wait' }],
    ['succeeded', 'pending', { action: 'finding', kind: 'succeeded_but_charge_not_succeeded' }],
    ['failed', 'pending', { action: 'finding', kind: 'failed_but_charge_open' }],
    // requires_action
    ['calling_processor', 'requires_action', { action: 'apply', outcome: { kind: 'requires_action', chargeId: 'ch_1' } }],
    ['processing', 'requires_action', { action: 'apply', outcome: { kind: 'requires_action', chargeId: 'ch_1' } }],
    ['requires_action', 'requires_action', { action: 'none' }],
    ['abandoned', 'requires_action', { action: 'wait' }],
    ['succeeded', 'requires_action', { action: 'finding', kind: 'succeeded_but_charge_not_succeeded' }],
    ['failed', 'requires_action', { action: 'finding', kind: 'failed_but_charge_open' }],
  ];

  it.each(rows)('attempt %s, charge %s', (status, chargeStatus, expected) => {
    expect(decide(attempt(status), charge(chargeStatus))).toMatchObject(expected);
  });

  it('covers every attempt status against every charge status (except created)', () => {
    const covered = new Set(rows.map(([a, c]) => `${a}/${c}`));
    for (const status of attemptMachine.statuses.filter((s) => s !== 'created')) {
      for (const c of ['succeeded', 'failed', 'pending', 'requires_action'] as const) {
        expect(covered.has(`${status}/${c}`)).toBe(true);
      }
    }
  });

  it('uses card_declined when the processor gives no failure code', () => {
    expect(decide(attempt('processing'), charge('failed', { failureCode: null }))).toMatchObject({
      outcome: { kind: 'declined', code: 'card_declined' },
    });
  });

  it('gives a call that may still be in flight time to finish, whatever the charge says', () => {
    for (const c of ['succeeded', 'failed', 'pending', 'requires_action'] as const) {
      expect(decide(attempt('calling_processor', { idleMs: 5000 }), charge(c))).toMatchObject({ action: 'wait' });
    }
  });

  it('never moves a final state on the strength of a lookup', () => {
    for (const status of ['succeeded', 'failed'] as const) {
      for (const c of ['succeeded', 'failed', 'pending', 'requires_action'] as const) {
        expect(decide(attempt(status), charge(c)).action).not.toBe('apply');
      }
    }
  });

  it('flags a different amount or currency, whatever the statuses', () => {
    expect(decide(attempt('processing'), charge('succeeded', { amount: 4999 }))).toMatchObject({ kind: 'amount_mismatch' });
    expect(decide(attempt('processing'), charge('succeeded', { currency: 'GHS' }))).toMatchObject({ kind: 'amount_mismatch' });
    expect(decide(attempt('succeeded'), charge('succeeded', { amount: 1 }))).toMatchObject({ kind: 'amount_mismatch' });
  });

  it('flags a charge id that differs from the one the attempt is bound to', () => {
    expect(decide(attempt('processing', { chargeId: 'ch_other' }), charge('succeeded'))).toMatchObject({ kind: 'charge_id_conflict' });
  });

  it('accepts an attempt that has no charge id yet', () => {
    expect(decide(attempt('calling_processor', { chargeId: null }), charge('succeeded'))).toMatchObject({ action: 'apply' });
  });

  it('flags a charge for an attempt that was never sent', () => {
    expect(decide(attempt('created'), charge('succeeded'))).toMatchObject({ kind: 'unexpected_charge' });
  });
});

describe('decideRecovery: the processor has no such charge', () => {
  it('waits while a call may still be running', () => {
    expect(decide(attempt('calling_processor', { idleMs: 119_999 }), null)).toMatchObject({ action: 'wait' });
  });

  it('abandons a call that has been silent for the stuck threshold: unknown, not failed', () => {
    expect(decide(attempt('calling_processor', { idleMs: 120_000 }), null)).toEqual({ action: 'abandon' });
  });

  it('keeps an abandoned attempt blocked inside the processor idempotency window', () => {
    expect(decide(attempt('abandoned', { ageMs: 89_999_999 }), null)).toMatchObject({ action: 'wait' });
  });

  it('fails an abandoned attempt only after the window, as "never reached the processor"', () => {
    expect(decide(attempt('abandoned', { ageMs: 90_000_000 }), null)).toEqual({ action: 'fail_unreached' });
  });

  it('measures the idempotency window from creation, not from the last change', () => {
    expect(decide(attempt('abandoned', { idleMs: 1000, ageMs: 100_000_000 }), null)).toEqual({ action: 'fail_unreached' });
  });

  it.each(['processing', 'requires_action'] as const)('flags %s without a charge at the processor', (status) => {
    expect(decide(attempt(status), null)).toMatchObject({ action: 'finding', kind: 'charge_missing' });
  });

  it('flags a booked success with no charge', () => {
    expect(decide(attempt('succeeded'), null)).toMatchObject({ action: 'finding', kind: 'success_without_charge' });
  });

  it.each(['created', 'failed'] as const)('has nothing to say about %s', (status) => {
    expect(decide(attempt(status), null)).toEqual({ action: 'none' });
  });
});
