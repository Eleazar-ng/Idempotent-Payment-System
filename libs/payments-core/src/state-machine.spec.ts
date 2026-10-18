import {
  attemptMachine,
  createStateMachine,
  InvalidTransitionError,
  intentMachine,
  isActiveAttemptStatus,
} from './index';

/**
 * The expected attempt matrix, written independently of the implementation: a flat list of the
 * allowed moves rather than an adjacency table. If both are wrong in the same way, the database
 * test (libs/db) still catches it, because the SQL tables are a third, separate encoding.
 */
const ALLOWED_ATTEMPT_MOVES = new Set([
  'created>calling_processor',
  'calling_processor>processing',
  'calling_processor>requires_action',
  'calling_processor>succeeded',
  'calling_processor>failed',
  'calling_processor>abandoned',
  'processing>requires_action',
  'processing>succeeded',
  'processing>failed',
  'processing>abandoned',
  'requires_action>processing',
  'requires_action>failed',
  'abandoned>succeeded',
  'abandoned>failed',
]);

const ATTEMPT_STATUSES = [
  'created',
  'calling_processor',
  'processing',
  'requires_action',
  'succeeded',
  'failed',
  'abandoned',
] as const;

describe('attemptMachine', () => {
  it('declares exactly the seven attempt statuses', () => {
    expect([...attemptMachine.statuses].sort()).toEqual([...ATTEMPT_STATUSES].sort());
    expect(attemptMachine.initial).toBe('created');
  });

  const pairs = ATTEMPT_STATUSES.flatMap((from) => ATTEMPT_STATUSES.map((to) => ({ from, to })));

  it.each(pairs)('$from -> $to', ({ from, to }) => {
    const expected = ALLOWED_ATTEMPT_MOVES.has(`${from}>${to}`);

    expect(attemptMachine.canTransition(from, to)).toBe(expected);

    if (expected) {
      expect(() => attemptMachine.assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => attemptMachine.assertTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });

  it('allows exactly the 14 listed moves and nothing else', () => {
    const actual = attemptMachine.edges().map(([from, to]) => `${from}>${to}`);
    expect(new Set(actual)).toEqual(ALLOWED_ATTEMPT_MOVES);
    expect(actual).toHaveLength(ALLOWED_ATTEMPT_MOVES.size);
  });

  it('treats staying in the same status as not a transition', () => {
    for (const status of ATTEMPT_STATUSES) {
      expect(attemptMachine.canTransition(status, status)).toBe(false);
    }
  });

  it('rejects statuses it has never heard of, from either side', () => {
    expect(attemptMachine.canTransition('created', 'refunded')).toBe(false);
    expect(attemptMachine.canTransition('refunded', 'created')).toBe(false);
    expect(attemptMachine.canTransition('', '')).toBe(false);
    expect(attemptMachine.canTransition('CREATED', 'calling_processor')).toBe(false);
    expect(attemptMachine.isTerminal('refunded')).toBe(false);
  });

  describe('structural properties', () => {
    it('can reach every status from the initial one (no orphan states)', () => {
      const seen = new Set<string>([attemptMachine.initial]);
      const queue: string[] = [attemptMachine.initial];
      while (queue.length > 0) {
        const current = queue.shift() as (typeof ATTEMPT_STATUSES)[number];
        for (const next of attemptMachine.nextStatuses(current)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].sort()).toEqual([...ATTEMPT_STATUSES].sort());
    });

    it('never moves back into the initial status', () => {
      expect(attemptMachine.legalPredecessors('created')).toEqual([]);
    });

    it('has exactly two terminal statuses: succeeded and failed', () => {
      const terminal = ATTEMPT_STATUSES.filter((s) => attemptMachine.isTerminal(s));
      expect(terminal.sort()).toEqual(['failed', 'succeeded']);
    });

    it('does not treat abandoned as terminal, because reconciliation resolves it either way', () => {
      expect(attemptMachine.isTerminal('abandoned')).toBe(false);
      expect(attemptMachine.nextStatuses('abandoned')).toEqual(['succeeded', 'failed']);
    });

    it('lets every non-terminal status reach a terminal one, so nothing can get stuck forever', () => {
      for (const status of ATTEMPT_STATUSES) {
        if (attemptMachine.isTerminal(status)) continue;
        const seen = new Set<string>([status]);
        const queue: string[] = [status];
        let reachesTerminal = false;
        while (queue.length > 0 && !reachesTerminal) {
          const current = queue.shift() as (typeof ATTEMPT_STATUSES)[number];
          for (const next of attemptMachine.nextStatuses(current)) {
            if (attemptMachine.isTerminal(next)) reachesTerminal = true;
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
        expect({ status, reachesTerminal }).toEqual({ status, reachesTerminal: true });
      }
    });
  });

  describe('legalPredecessors', () => {
    it('lists every status that may precede succeeded (what a webhook or reconciliation may overwrite)', () => {
      expect([...attemptMachine.legalPredecessors('succeeded')].sort()).toEqual([
        'abandoned',
        'calling_processor',
        'processing',
      ]);
    });

    it('lists the statuses that may precede failed', () => {
      expect([...attemptMachine.legalPredecessors('failed')].sort()).toEqual([
        'abandoned',
        'calling_processor',
        'processing',
        'requires_action',
      ]);
    });

    it('never includes a terminal status as a predecessor of anything', () => {
      for (const to of ATTEMPT_STATUSES) {
        for (const from of attemptMachine.legalPredecessors(to)) {
          expect(attemptMachine.isTerminal(from)).toBe(false);
        }
      }
    });
  });

  describe('the scenarios the table exists to stop (Module 5.6)', () => {
    it('a stale "failed" event cannot overwrite a confirmed success', () => {
      expect(attemptMachine.canTransition('succeeded', 'failed')).toBe(false);
    });

    it('a stale "processing" event cannot pull a succeeded attempt backwards', () => {
      expect(attemptMachine.canTransition('succeeded', 'processing')).toBe(false);
    });

    it('a timeout job cannot fail an attempt that already succeeded (Module 4.3)', () => {
      expect(attemptMachine.canTransition('succeeded', 'failed')).toBe(false);
      expect(attemptMachine.canTransition('succeeded', 'abandoned')).toBe(false);
    });

    it('a failed attempt can never be revived: a retry is a new attempt (Module 5.8)', () => {
      for (const to of ATTEMPT_STATUSES) {
        expect(attemptMachine.canTransition('failed', to)).toBe(false);
      }
    });
  });

  it('reports the offending move in the error', () => {
    try {
      attemptMachine.assertTransition('succeeded', 'failed');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const e = error as InvalidTransitionError;
      expect(e.message).toBe('Invalid payment_attempt status transition: succeeded -> failed');
      expect(e.code).toBe('INVALID_TRANSITION');
      expect({ entity: e.entity, from: e.from, to: e.to }).toEqual({
        entity: 'payment_attempt',
        from: 'succeeded',
        to: 'failed',
      });
    }
  });

  it('cannot be altered by callers', () => {
    const next = attemptMachine.nextStatuses('created') as string[];
    expect(() => next.push('succeeded')).toThrow(TypeError);
    expect(attemptMachine.canTransition('created', 'succeeded')).toBe(false);
    expect(() => {
      (attemptMachine as unknown as { initial: string }).initial = 'succeeded';
    }).toThrow(TypeError);
  });
});

describe('isActiveAttemptStatus', () => {
  it('is true for every status except failed (the predicate of the one-active-attempt index)', () => {
    for (const status of ATTEMPT_STATUSES) {
      expect(isActiveAttemptStatus(status)).toBe(status !== 'failed');
    }
  });

  it('includes abandoned, so an unknown outcome blocks a new attempt', () => {
    expect(isActiveAttemptStatus('abandoned')).toBe(true);
  });
});

describe('intentMachine', () => {
  it('moves from open to succeeded or canceled, and nowhere after that', () => {
    expect(intentMachine.initial).toBe('open');
    expect(intentMachine.edges()).toEqual([
      ['open', 'succeeded'],
      ['open', 'canceled'],
    ]);
    expect(intentMachine.isTerminal('succeeded')).toBe(true);
    expect(intentMachine.isTerminal('canceled')).toBe(true);
    expect(intentMachine.isTerminal('open')).toBe(false);
  });

  it.each([
    ['succeeded', 'open'],
    ['succeeded', 'canceled'],
    ['canceled', 'open'],
    ['canceled', 'succeeded'],
  ])('refuses %s -> %s', (from, to) => {
    expect(() => intentMachine.assertTransition(from, to)).toThrow(InvalidTransitionError);
  });
});

describe('createStateMachine validates its own definition', () => {
  it('rejects a transition to a status that was never declared', () => {
    expect(() =>
      createStateMachine({
        name: 'broken',
        initial: 'a',
        transitions: { a: ['ghost' as 'a'], b: [] } as Record<'a' | 'b', readonly ('a' | 'b')[]>,
      }),
    ).toThrow(/undeclared status/);
  });

  it('rejects an initial status that was never declared', () => {
    expect(() =>
      createStateMachine({
        name: 'broken',
        initial: 'ghost' as 'a',
        transitions: { a: [] },
      }),
    ).toThrow(/initial status/);
  });

  it('rejects a self-transition, which would be a move that changes nothing', () => {
    expect(() =>
      createStateMachine({
        name: 'broken',
        initial: 'a',
        transitions: { a: ['a'] },
      }),
    ).toThrow(/self-transition/);
  });
});
