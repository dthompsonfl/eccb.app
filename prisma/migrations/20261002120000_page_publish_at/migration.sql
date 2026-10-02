-- Scheduled CMS publishing: give Page a canonical `publishAt` instant.
--
-- Page.scheduledFor already existed and the public catch-all route already
-- withheld pages whose scheduledFor was still in the future, but the value was
-- only reachable by duplicating the logic in every read path. This adds
-- `publishAt` as the single column the visibility check reads, and backfills it
-- from scheduledFor so pages that were already scheduled through the admin UI
-- keep their existing schedule instead of silently going live.
--
-- Nullable with no default: a null publishAt means "no schedule", so a page
-- that was never scheduled is unaffected.

ALTER TABLE `Page` ADD COLUMN `publishAt` DATETIME(3) NULL;

UPDATE `Page` SET `publishAt` = `scheduledFor` WHERE `scheduledFor` IS NOT NULL;

-- The scheduler scans for due pages on an index-backed predicate every minute.
CREATE INDEX `Page_publishAt_idx` ON `Page`(`publishAt`);
