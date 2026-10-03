-- Client-generated idempotency key for stand annotations.
--
-- WHY THIS COLUMN EXISTS
--
-- The offline annotation queue (`src/lib/stand/use-offline-annotations.ts`) makes
-- a promise in its own docblock:
--
--   "Idempotency. Replay is keyed on a client-generated id, so a flaky connection
--    that retries cannot create a second copy of the same stroke."
--
-- That promise was unimplementable. `Annotation` had no column to record the
-- client id, so replaying a queue after a timeout — the exact case the queue
-- exists for — created a SECOND row for the same physical pencil stroke. The
-- musician saw their mark appear twice on the score.
--
-- The queue was also dead code (no caller), so the defect was invisible: the
-- feature was off, and its only correct behaviour was untested. Both are fixed
-- together — the column below makes the promise true, and the queue is now wired
-- into StandViewer.
--
-- UNIQUENESS
--
-- UNIQUE on (userId, clientId), not on clientId alone:
--   * clientId is generated per browser. Two members who happen to generate the
--     same id must not collide, so userId is part of the key. Without it, one
--     member's stroke could be silently attributed as a no-op duplicate of
--     another's.
--   * NULLs are not compared by MySQL/MariaDB unique indexes, so every annotation
--     created WITHOUT a client id (every existing caller, including the live
--     online path) is exempt. This is why the column is nullable rather than
--     defaulted: a default would fabricate an id and make unrelated annotations
--     collide.
--
-- The composite key is what makes the write idempotent at the database level.
-- Application-level "check then insert" cannot: two concurrent replays of the
-- same queued stroke both pass the check and both insert. The constraint is the
-- only thing that actually prevents the duplicate.
--
-- Collation: utf8mb4_unicode_ci, matching every other table in this schema.

ALTER TABLE `Annotation`
  ADD COLUMN `clientId` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `Annotation_userId_clientId_key`
  ON `Annotation` (`userId`, `clientId`);