/**
 * Singleton guard for the process manager.
 *
 * `npm run start:all` twice is a real operator mistake (a re-run in CI, a
 * forgotten terminal). Without a guard the second manager resolves its ports,
 * finds them free because the first manager rolled forward, and cheerfully
 * starts a *second* set of workers against the same database. Two worker
 * processes means BullMQ jobs are consumed twice and the scheduler fires every
 * tick twice — duplicate emails, duplicate reminders, no error anywhere.
 *
 * The lock is a PID file plus an `livenessCheck` so staleness is decidable:
 * a lock whose owner is gone is reclaimed, a lock whose owner is alive is a
 * hard error naming the PID.
 */

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';

export interface LockOwner {
  pid: number;
  startedAt: string;
  appPort: number;
  workerHealthPort: number;
  managerHealthPort: number;
  socketPort: number;
}

export interface LockOptions {
  lockDir: string;
  /** Overridable so tests never depend on the real process table. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

export const DEFAULT_LOCK_DIRNAME = '.next/process-manager.lock';

export class AlreadyRunningError extends Error {
  readonly owner: LockOwner;

  constructor(owner: LockOwner) {
    super(
      `Another ECCB process manager is already running (PID ${owner.pid}, started ${owner.startedAt}, ` +
        `app port ${owner.appPort}, manager health port ${owner.managerHealthPort}). ` +
        'Stop it first, or run this manager from the other deployment.',
    );
    this.name = 'AlreadyRunningError';
    this.owner = owner;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claim the singleton lock, or throw `AlreadyRunningError`.
 *
 * Returns a release function. Callers must invoke it on shutdown; the lock
 * file is also reclaimed automatically once its owner dies, so a hard kill
 * (SIGKILL, power loss) does not wedge the next start.
 */
export async function acquireLock(
  owner: Omit<LockOwner, 'startedAt'> & { startedAt?: string },
  options: LockOptions,
): Promise<{ release: () => Promise<void>; owner: LockOwner }> {
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;
  const lockDir = options.lockDir;

  await mkdir(lockDir, { recursive: true });

  const existing = await readOwner(lockDir);
  if (existing && isAlive(existing.pid)) {
    throw new AlreadyRunningError(existing);
  }
  if (existing) {
    // Stale: the recorded owner is gone. Reclaim rather than refusing, and say so.
    console.warn(
      `[ProcessManager] Reclaiming stale lock from PID ${existing.pid} (process is no longer running).`,
    );
  }

  const full: LockOwner = {
    ...owner,
    startedAt: owner.startedAt ?? new Date(now()).toISOString(),
  };

  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(full, null, 2), 'utf8');

  let released = false;
  return {
    owner: full,
    release: async () => {
      if (released) return;
      released = true;
      // Only remove the file if it is still ours — a reclaimed lock belongs to
      // a newer manager and must not be deleted by this one shutting down.
      const current = await readOwner(lockDir);
      if (current && current.pid !== full.pid) return;
      await rm(path.join(lockDir, 'owner.json'), { force: true });
    },
  };
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(path.join(lockDir, 'owner.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<LockOwner>;
    if (typeof record.pid !== 'number') return null;
    return {
      pid: record.pid,
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : 'unknown',
      appPort: typeof record.appPort === 'number' ? record.appPort : 0,
      workerHealthPort: typeof record.workerHealthPort === 'number' ? record.workerHealthPort : 0,
      managerHealthPort: typeof record.managerHealthPort === 'number' ? record.managerHealthPort : 0,
      socketPort: typeof record.socketPort === 'number' ? record.socketPort : 0,
    };
  } catch {
    return null;
  }
}

/** Read the current lock owner without acquiring. Used by diagnostics. */
export async function peekLock(lockDir: string): Promise<LockOwner | null> {
  return readOwner(lockDir);
}