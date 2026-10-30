import type { Kysely } from 'kysely';
import { decideRecovery } from '@app/payments-core';
import type { ChargeSnapshot, RecoveryPolicy } from '@app/payments-core';
import {
  applyRecoveryDecision,
  ingestWebhookAttentionAsFindings,
  loadAttemptsForReconciliation,
  recordFinding,
  resolveFindingsNoLongerObserved,
} from '@app/db';
import type { Database } from '@app/db';
import { ProcessorLookup } from './processor-lookup';

export interface ReconcilerOptions extends RecoveryPolicy {
  /** Attempts and charges created within this window are compared (plus every unresolved attempt). */
  lookbackMs: number;
  feeBps: number;
  now?: () => Date;
  log?: (level: 'warn' | 'error', message: string) => void;
}

export interface ReconcileSummary {
  attemptsCompared: number;
  chargesListed: number;
  repaired: number;
  findingsRecorded: number;
  findingsClosed: number;
  webhookFindingsCreated: number;
}

/**
 * The full comparison: our attempts against the processor's charges (Module 9). Webhooks and the sweeper
 * should already have kept the two in step; this is what catches whatever got through anyway, a webhook
 * that never came, a payment nobody was looking at, a charge we know nothing about.
 *
 * It repairs what the processor's answer makes unambiguous (the same decisions the sweeper takes) and
 * records everything else as a finding, once. It does NOT move money state on its own judgement: a charge
 * that succeeded against an attempt we hold as failed is a finding for a person.
 *
 * If the processor cannot be listed the run fails before touching anything, and in particular before
 * closing any finding: no answer is not "the discrepancies are gone".
 */
export class Reconciler {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly lookup: ProcessorLookup,
    private readonly options: ReconcilerOptions,
  ) {}

  async runOnce(): Promise<ReconcileSummary> {
    const runStart = this.now();
    const createdAfter = new Date(runStart.getTime() - this.options.lookbackMs);

    const listed = await this.lookup.listCharges(); // throws ProcessorLookupError: nothing below runs
    const attempts = await loadAttemptsForReconciliation(this.db, { now: runStart, createdAfter });

    const byReference = new Map<string, ChargeSnapshot>();
    for (const l of listed) if (l.reference) byReference.set(l.reference, l.charge);
    const knownReferences = new Set(attempts.map((a) => a.reference));

    const summary: ReconcileSummary = {
      attemptsCompared: attempts.length,
      chargesListed: listed.length,
      repaired: 0,
      findingsRecorded: 0,
      findingsClosed: 0,
      webhookFindingsCreated: 0,
    };
    const examinedAttempts = new Set<number>();
    const examinedCharges = new Set<string>();

    for (const attempt of attempts) {
      examinedAttempts.add(attempt.attemptId);
      const charge = byReference.get(attempt.reference) ?? null;
      if (charge) examinedCharges.add(charge.id);

      const decision = decideRecovery(
        {
          status: attempt.status,
          chargeId: attempt.chargeId,
          amount: attempt.amount,
          currency: attempt.currency,
          idleMs: attempt.idleMs,
          ageMs: attempt.ageMs,
        },
        charge,
        this.options,
      );

      if (decision.action === 'finding') {
        await recordFinding(this.db, {
          kind: decision.kind,
          source: 'reconciliation',
          dedupeKey: `${decision.kind}:attempt:${attempt.attemptId}`,
          attemptId: attempt.attemptId,
          chargeId: charge?.id ?? attempt.chargeId,
          detail: decision.detail,
          now: this.now(),
        });
        this.log('error', `reconciliation: attempt ${attempt.attemptId}: ${decision.kind}: ${decision.detail}`);
        summary.findingsRecorded++;
      } else if (decision.action === 'apply' || decision.action === 'abandon' || decision.action === 'fail_unreached') {
        const result = await applyRecoveryDecision(this.db, attempt, decision, { feeBps: this.options.feeBps });
        if (result.applied) summary.repaired++;
      }
    }

    // Charges that none of our attempts explains.
    const cutoffSeconds = createdAfter.getTime() / 1000;
    for (const l of listed) {
      const recent = l.created === undefined || l.created >= cutoffSeconds;
      if (!recent) continue;
      examinedCharges.add(l.charge.id);
      if (l.reference && knownReferences.has(l.reference)) continue;
      await recordFinding(this.db, {
        kind: 'orphan_charge',
        source: 'reconciliation',
        dedupeKey: `orphan_charge:${l.charge.id}`,
        chargeId: l.charge.id,
        detail: `processor charge ${l.charge.id} (${l.charge.amount} ${l.charge.currency}, ${l.charge.status}) matches none of our attempts`,
        now: this.now(),
      });
      this.log('error', `reconciliation: orphan charge ${l.charge.id}`);
      summary.findingsRecorded++;
    }

    summary.webhookFindingsCreated = await ingestWebhookAttentionAsFindings(this.db, this.now());
    summary.findingsClosed = await resolveFindingsNoLongerObserved(this.db, {
      sources: ['recovery', 'reconciliation'],
      seenBefore: runStart,
      now: this.now(),
      examinedAttemptIds: examinedAttempts,
      examinedChargeIds: examinedCharges,
    });
    return summary;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private log(level: 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
  }
}
