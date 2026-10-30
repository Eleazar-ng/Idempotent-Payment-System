import type { Kysely } from 'kysely';
import { decideRecovery } from '@app/payments-core';
import type { RecoveryPolicy } from '@app/payments-core';
import {
  applyRecoveryDecision,
  completeOrphanedKeys,
  findRecoveryCandidates,
  recordFinding,
  releaseStaleClaims,
} from '@app/db';
import type { Database, RecoveryCandidate } from '@app/db';
import { ProcessorLookup } from './processor-lookup';

export interface RecoverySweeperOptions extends RecoveryPolicy {
  /** `processing` and `requires_action` attempts idle this long are looked at (webhooks normally finish them first). */
  pendingAfterMs: number;
  /** A claim with no attempt older than this is released. */
  claimStaleAfterMs: number;
  batchSize: number;
  /** Lookups in flight at once. */
  concurrency: number;
  feeBps: number;
  now?: () => Date;
  log?: (level: 'warn' | 'error', message: string) => void;
}

export interface SweepSummary {
  examined: number;
  applied: number;
  abandoned: number;
  failedUnreached: number;
  waiting: number;
  alreadyDone: number;
  findings: number;
  lookupErrors: number;
  keysCompleted: number;
  claimsReleased: number;
}

/**
 * Rescues payments that were left half way (Module 9). Looks at attempts that are stuck, asks the
 * processor about each, and lets `decideRecovery` say what to do. It changes an attempt only when the
 * processor has said something definitive; a failed lookup changes nothing. It also finishes the
 * idempotency keys that dead requests left hanging, so a client's retry gets an answer.
 *
 * Safe to run on any number of workers at once: every step is conditional on the status it was decided
 * against, so concurrent sweepers, webhooks and API requests end with one winner.
 */
export class RecoverySweeper {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly lookup: ProcessorLookup,
    private readonly options: RecoverySweeperOptions,
  ) {}

  async runOnce(): Promise<SweepSummary> {
    const now = this.now();
    const summary: SweepSummary = {
      examined: 0,
      applied: 0,
      abandoned: 0,
      failedUnreached: 0,
      waiting: 0,
      alreadyDone: 0,
      findings: 0,
      lookupErrors: 0,
      keysCompleted: 0,
      claimsReleased: 0,
    };

    summary.claimsReleased = await releaseStaleClaims(this.db, { now, olderThanMs: this.options.claimStaleAfterMs });
    summary.keysCompleted = await completeOrphanedKeys(this.db, {
      now,
      olderThanMs: this.options.claimStaleAfterMs,
      limit: this.options.batchSize,
    });

    const candidates = await findRecoveryCandidates(this.db, {
      now,
      stuckAfterMs: this.options.stuckAfterMs,
      pendingAfterMs: this.options.pendingAfterMs,
      limit: this.options.batchSize,
    });
    summary.examined = candidates.length;

    for (let i = 0; i < candidates.length; i += this.options.concurrency) {
      const chunk = candidates.slice(i, i + this.options.concurrency);
      await Promise.all(chunk.map((candidate) => this.handle(candidate, summary, now)));
    }
    return summary;
  }

  private async handle(candidate: RecoveryCandidate, summary: SweepSummary, now: Date): Promise<void> {
    try {
      const charge = await this.lookup.findByReference(candidate.reference);
      const decision = decideRecovery(
        {
          status: candidate.status,
          chargeId: candidate.chargeId,
          amount: candidate.amount,
          currency: candidate.currency,
          idleMs: candidate.idleMs,
          ageMs: candidate.ageMs,
        },
        charge,
        this.options,
      );

      if (decision.action === 'finding') {
        await recordFinding(this.db, {
          kind: decision.kind,
          source: 'recovery',
          dedupeKey: `${decision.kind}:attempt:${candidate.attemptId}`,
          attemptId: candidate.attemptId,
          chargeId: charge?.id ?? candidate.chargeId,
          detail: decision.detail,
          now,
        });
        this.log('error', `attempt ${candidate.attemptId}: ${decision.kind}: ${decision.detail}`);
        summary.findings++;
        return;
      }
      if (decision.action === 'none' || decision.action === 'wait') {
        summary.waiting++;
        return;
      }

      const result = await applyRecoveryDecision(this.db, candidate, decision, { feeBps: this.options.feeBps });
      if (result.applied) {
        if (decision.action === 'abandon') summary.abandoned++;
        else if (decision.action === 'fail_unreached') summary.failedUnreached++;
        else summary.applied++;
      } else if (result.reason === 'already_applied' || result.reason === 'stale') {
        summary.alreadyDone++;
      }
    } catch (error) {
      // A lookup that failed, or anything else unexpected: leave the attempt exactly as it is.
      summary.lookupErrors++;
      this.log('warn', `attempt ${candidate.attemptId}: left unchanged: ${String(error)}`);
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private log(level: 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
  }
}
