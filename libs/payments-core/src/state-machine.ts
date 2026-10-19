import { InvalidTransitionError } from './errors';

/**
 * A small, immutable finite state machine: a set of statuses, an initial status, and the exact
 * list of legal moves between them (Module 5). It holds no state itself; it only answers
 * "is this move allowed?".
 *
 * The database enforces the same rules with triggers (migration 0002). This copy exists so the
 * application can fail fast and reason about states (for example "which statuses may precede
 * succeeded?") without a round trip. A test compares the two, so they cannot drift apart.
 */
export interface StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly statuses: readonly S[];

  /**
   * Whether moving from `from` to `to` is a legal transition. Staying in the same status is not a
   * transition, so `canTransition(x, x)` is false; callers that must tolerate duplicate delivery
   * of the same event handle that case separately (see `already_applied` in the repository).
   */
  canTransition(from: string, to: string): boolean;

  /** Throws InvalidTransitionError unless the move is legal. */
  assertTransition(from: string, to: string): void;

  /** Statuses reachable in one step from `from` (empty for a terminal status). */
  nextStatuses(from: S): readonly S[];

  /** Statuses from which `to` can be reached in one step. */
  legalPredecessors(to: S): readonly S[];

  /** A terminal status has no outgoing moves: once there, the row never changes status again. */
  isTerminal(status: string): boolean;

  /** Every legal move as [from, to] pairs, for tests and for comparing with the database. */
  edges(): ReadonlyArray<readonly [S, S]>;
}

export function createStateMachine<S extends string>(config: {
  name: string;
  initial: S;
  transitions: Readonly<Record<S, readonly S[]>>;
}): StateMachine<S> {
  const { name, initial, transitions } = config;
  const statuses = Object.freeze(Object.keys(transitions) as S[]);
  const known = new Set<string>(statuses);

  // Validate the definition once, at startup, so a typo cannot silently create a state that
  // nothing can reach or leave.
  if (!known.has(initial)) {
    throw new Error(`${name}: initial status "${initial}" is not a declared status`);
  }
  for (const from of statuses) {
    for (const to of transitions[from]) {
      if (!known.has(to)) {
        throw new Error(`${name}: transition ${from} -> ${to} targets an undeclared status`);
      }
      if (to === from) {
        throw new Error(`${name}: ${from} -> ${to} is a self-transition; staying put is not a move`);
      }
    }
  }

  const frozen = Object.fromEntries(
    statuses.map((s) => [s, Object.freeze([...transitions[s]])]),
  ) as Record<S, readonly S[]>;

  const canTransition = (from: string, to: string): boolean =>
    known.has(from) && known.has(to) && frozen[from as S].includes(to as S);

  return Object.freeze({
    name,
    initial,
    statuses,

    canTransition,

    assertTransition(from: string, to: string): void {
      if (!canTransition(from, to)) {
        throw new InvalidTransitionError(name, from, to);
      }
    },

    nextStatuses: (from: S) => frozen[from],

    legalPredecessors: (to: S) => Object.freeze(statuses.filter((s) => frozen[s].includes(to))),

    isTerminal: (status: string) => known.has(status) && frozen[status as S].length === 0,

    edges: () => statuses.flatMap((from) => frozen[from].map((to) => [from, to] as const)),
  });
}
