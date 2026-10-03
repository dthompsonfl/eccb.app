/**
 * Tests for the process-manager singleton lock.
 *
 * Double `start:all` is the idempotency question: a second manager would
 * otherwise start a duplicate worker fleet against the same database, so
 * BullMQ jobs run twice and the scheduler fires every tick twice — with no
 * error anywhere.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { acquireLock, AlreadyRunningError, peekLock } from '../process-lock';

async function tempLockDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'eccb-lock-'));
}

const OWNER = { pid: 4242, appPort: 3225, workerHealthPort: 3227, managerHealthPort: 3228, socketPort: 3226 };

describe('acquireLock', () => {
  it('grants the lock to the first caller and records the owner', async () => {
    const lockDir = await tempLockDir();
    try {
      const lock = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      const owner = await peekLock(lockDir);
      expect(owner).toMatchObject({ pid: 4242, appPort: 3225, socketPort: 3226 });
      await lock.release();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('refuses a second manager while the first owner is alive', async () => {
    const lockDir = await tempLockDir();
    try {
      const first = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      await expect(
        acquireLock({ ...OWNER, pid: 5555 }, { lockDir, isProcessAlive: (pid) => pid === 4242 }),
      ).rejects.toBeInstanceOf(AlreadyRunningError);
      await first.release();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('names the holding PID and its ports in the error so the operator can act', async () => {
    const lockDir = await tempLockDir();
    try {
      const first = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      await expect(
        acquireLock({ ...OWNER, pid: 5555 }, { lockDir, isProcessAlive: () => true }),
      ).rejects.toThrow(/PID 4242/);
      await expect(
        acquireLock({ ...OWNER, pid: 5555 }, { lockDir, isProcessAlive: () => true }),
      ).rejects.toThrow(/app port 3225/);
      await first.release();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock whose owner is gone', async () => {
    const lockDir = await tempLockDir();
    try {
      const first = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      // Simulate a SIGKILL: the file remains but the process does not.
      const second = await acquireLock(
        { ...OWNER, pid: 5555 },
        { lockDir, isProcessAlive: (pid) => pid !== 4242 },
      );
      expect((await peekLock(lockDir))?.pid).toBe(5555);

      // The old owner shutting down later must NOT delete the new owner's lock.
      await first.release();
      expect((await peekLock(lockDir))?.pid).toBe(5555);

      await second.release();
      expect(await peekLock(lockDir)).toBeNull();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('release is idempotent', async () => {
    const lockDir = await tempLockDir();
    try {
      const lock = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      await lock.release();
      await lock.release();
      expect(await peekLock(lockDir)).toBeNull();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt lock file as absent rather than blocking forever', async () => {
    const lockDir = await tempLockDir();
    try {
      const { writeFile, mkdir } = await import('fs/promises');
      await mkdir(lockDir, { recursive: true });
      await writeFile(path.join(lockDir, 'owner.json'), '{ not json', 'utf8');

      const lock = await acquireLock(OWNER, { lockDir, isProcessAlive: () => true });
      expect((await peekLock(lockDir))?.pid).toBe(4242);
      await lock.release();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it('writes a startedAt timestamp', async () => {
    const lockDir = await tempLockDir();
    try {
      const lock = await acquireLock(OWNER, {
        lockDir,
        isProcessAlive: () => true,
        now: () => Date.parse('2026-01-02T03:04:05.000Z'),
      });
      expect(lock.owner.startedAt).toBe('2026-01-02T03:04:05.000Z');
      const raw = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
      expect(raw.startedAt).toBe('2026-01-02T03:04:05.000Z');
      await lock.release();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});