/**
 * Tests for the child restart policy.
 *
 * Two defects are pinned here:
 *  1. The restart storm — a fixed 1s delay plus a `lastRestart` value only
 *     mutated inside the restart timer let an instantly-failing child burn all
 *     five attempts in under a second and then stop permanently.
 *  2. The permanent-outage variant — a child that ran healthily for days could
 *     still be left with an exhausted budget from unrelated crashes.
 */

import { describe, expect, it } from 'vitest';
import { decideRestart, describeRestartReason, RestartPolicyOptions } from '../restart-policy';

// A realistic epoch timestamp, not a small counter: `lastRestart` is derived
// by subtracting a duration from `now`, and a small base would make that go
// negative and look like "never started".
const NOW = 1_800_000_000_000;

function options(overrides: Partial<RestartPolicyOptions> = {}): RestartPolicyOptions {
  return {
    enabled: true,
    isShuttingDown: false,
    exitCode: 1,
    exitSignal: null,
    restartCount: 0,
    lastRestart: 0,
    now: NOW,
    maxRestarts: 5,
    stableUptimeMs: 60_000,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    ...overrides,
  };
}

describe('decideRestart', () => {
  it('does not restart a child that exited cleanly', () => {
    const decision = decideRestart(options({ exitCode: 0, exitSignal: null }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('clean-exit');
  });

  it('restarts a child killed by a signal even with a null exit code', () => {
    // OOM-kill and SIGKILL both surface as code=null; treating that as a clean
    // exit would leave the deployment permanently degraded.
    const decision = decideRestart(options({ exitCode: null, exitSignal: 'SIGKILL' }));
    expect(decision.shouldRestart).toBe(true);
  });

  it('does not restart during shutdown', () => {
    const decision = decideRestart(options({ isShuttingDown: true }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('shutting-down');
  });

  it('does not restart when restarting is disabled', () => {
    const decision = decideRestart(options({ enabled: false }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('restart-disabled');
  });

  it('backs off exponentially instead of restarting instantly in a loop', () => {
    const delays = [0, 1, 2, 3, 4].map(
      (count) =>
        decideRestart(
          options({
            restartCount: count,
            // lastRestart just now => no stability reset
            lastRestart: NOW,
          }),
        ).delayMs,
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
    // The whole budget now spans ~31s of backoff instead of ~5s of hammering.
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(30_000);
  });

  it('caps the backoff delay', () => {
    // 2^4 * 1000 = 16000 is under the cap; 2^5 would be 32000, so the highest
    // in-budget attempt (index 4) is still below it. Raising maxRestarts is
    // what actually exercises the cap.
    const decision = decideRestart(
      options({ restartCount: 4, lastRestart: NOW, maxRestarts: 20 }),
    );
    expect(decision.delayMs).toBe(16_000);

    const capped = decideRestart(options({ restartCount: 10, lastRestart: NOW, maxRestarts: 20 }));
    expect(capped.delayMs).toBe(30_000);
  });

  it('stops after the restart budget is exhausted', () => {
    const decision = decideRestart(options({ restartCount: 5, lastRestart: NOW }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('budget-exhausted');
  });

  it('restores the budget after a long stable uptime', () => {
    // Five crashes last week, the child has run fine for a day since: it must
    // be restartable again, not permanently written off.
    const decision = decideRestart(
      options({ restartCount: 5, lastRestart: NOW - 24 * 60 * 60 * 1000 }),
    );
    expect(decision.shouldRestart).toBe(true);
    expect(decision.attempt).toBe(1);
    expect(decision.delayMs).toBe(1000);
  });

  it('does not restore the budget just under the stability threshold', () => {
    const decision = decideRestart(options({ restartCount: 5, lastRestart: NOW - 59_000 }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('budget-exhausted');
  });

  it('consumes exactly one attempt per decision and never mutates its input', () => {
    const input = options({ restartCount: 2, lastRestart: NOW });
    const snapshot = { ...input };
    const decision = decideRestart(input);
    expect(decision.attempt).toBe(3);
    expect(input).toEqual(snapshot);
  });

  it('treats a never-started child (lastRestart 0) as having no stable uptime', () => {
    // now - 0 is enormous, so a naive stability check would hand a crash-looping
    // child a fresh budget on every single failure.
    const decision = decideRestart(options({ restartCount: 5, lastRestart: 0 }));
    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('budget-exhausted');
  });

  it('gives every reason a human-readable explanation', () => {
    for (const reason of ['restart', 'budget-exhausted', 'shutting-down', 'restart-disabled', 'clean-exit'] as const) {
      expect(describeRestartReason(reason).length).toBeGreaterThan(0);
    }
  });
});