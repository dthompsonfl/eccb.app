/**
 * Restart policy for the process manager's children.
 *
 * Extracted from `scripts/start.ts` as a pure function so the failure modes
 * that matter — a restart storm and a restart that reuses a dead port — are
 * unit-testable without spawning real processes.
 */

export interface RestartDecision {
  /** True when the child should be restarted. */
  shouldRestart: boolean;
  /** Delay before the restart, in ms. Only meaningful when `shouldRestart`. */
  delayMs: number;
  /** Why the child is not being restarted, for the operator-facing log. */
  reason:
    | 'restart'
    | 'budget-exhausted'
    | 'shutting-down'
    | 'restart-disabled'
    | 'clean-exit';
  /** Restart attempt number this decision consumes, or the current count. */
  attempt: number;
}

export interface RestartPolicyOptions {
  enabled: boolean;
  isShuttingDown: boolean;
  /** Exit code of the child; null when it was terminated by a signal. */
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  /** Restarts already consumed since the last budget reset. */
  restartCount: number;
  /** Timestamp of the last (re)start, or 0 when never started. */
  lastRestart: number;
  now: number;
  maxRestarts: number;
  stableUptimeMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Decide whether and when to restart a child that just exited.
 *
 * `restartCount` is returned (not mutated) so the caller owns the state; the
 * caller applies `attempt` after actually respawning.
 */
export function decideRestart(options: RestartPolicyOptions): RestartDecision {
  const {
    enabled,
    isShuttingDown,
    exitCode,
    exitSignal,
    restartCount,
    lastRestart,
    now,
    maxRestarts,
    stableUptimeMs,
    baseDelayMs,
    maxDelayMs,
  } = options;

  // A clean exit(0) is not a crash. Only a non-zero code or a signal counts.
  const crashed = exitCode !== 0 || exitSignal !== null;

  if (!crashed) {
    return { shouldRestart: false, delayMs: 0, reason: 'clean-exit', attempt: restartCount };
  }
  if (isShuttingDown) {
    return { shouldRestart: false, delayMs: 0, reason: 'shutting-down', attempt: restartCount };
  }
  if (!enabled) {
    return { shouldRestart: false, delayMs: 0, reason: 'restart-disabled', attempt: restartCount };
  }

  // A child that stayed up longer than the stability window has earned a
  // fresh budget. Without this, five crashes spread across a week would
  // permanently disable restarting for a process that is otherwise healthy.
  //
  // `lastRestart === 0` means "never successfully started". It must NOT count
  // as a long stable uptime: `now - 0` is an enormous number, so treating it
  // as stable would hand a crash-looping child a fresh budget on every single
  // failure — exactly the storm this policy exists to prevent.
  const hasStableUptime = lastRestart > 0 && now - lastRestart >= stableUptimeMs;
  const effectiveCount = hasStableUptime ? 0 : restartCount;

  if (effectiveCount >= maxRestarts) {
    return { shouldRestart: false, delayMs: 0, reason: 'budget-exhausted', attempt: effectiveCount };
  }

  // Exponential backoff. The previous implementation used a fixed 1s delay
  // combined with a `lastRestart` value that was only mutated inside the timer,
  // so an instantly-failing child burned all five attempts in under a second
  // and then stopped permanently — a restart storm followed by a silent
  // permanent outage.
  const delayMs = Math.min(baseDelayMs * 2 ** effectiveCount, maxDelayMs);

  return { shouldRestart: true, delayMs, reason: 'restart', attempt: effectiveCount + 1 };
}

/** Human-readable explanation for each non-restart reason. */
export function describeRestartReason(reason: RestartDecision['reason']): string {
  switch (reason) {
    case 'restart':
      return 'child crashed; restarting';
    case 'budget-exhausted':
      return 'restart budget exhausted after repeated crashes';
    case 'shutting-down':
      return 'the process manager is shutting down';
    case 'restart-disabled':
      return 'RESTART_CRASHED_PROCESSES is false';
    case 'clean-exit':
      return 'child exited cleanly';
  }
}