-- Web push subscriptions and per-member push consent.
--
-- Two tables, one invariant: NOTHING here is enabled without an explicit act
-- by the member.
--
-- `pushEnabled` DEFAULT FALSE. "Push enabled" is personal data under GDPR — it
-- records that a member agreed to be contacted on this account. Defaulting it
-- to TRUE would enrol every existing member in a new processing activity with
-- no consent record, which is exactly the failure the default prevents. The
-- send path additionally refuses to send when pushConsentedAt IS NULL, so a
-- database default mistake alone still cannot deliver a push.
--
-- `pushConsentedAt` records WHEN consent was given, so an Art. 7(1) "record of
-- consent" exists and withdrawal can be distinguished from never-having-had.
--
-- `endpoint` is UNIQUE, not (userId, endpoint). The endpoint URL is the push
-- service's identifier for a (browser, application-server-key) pair, so it is
-- globally unique by construction. Making it unique per-user would let one
-- browser that is signed into two accounts keep two live rows, and would let a
-- re-subscribe accumulate duplicates. Uniqueness on the endpoint alone means an
-- upsert can never duplicate a registration.
--
-- Deletion behaviour:
--   * PushSubscription.userId -> User : ON DELETE CASCADE. An endpoint is
--     personal data tied to one account; deleting the account must erase it,
--     not orphan a push URL that keeps resolving to a dead member id.
--
-- Collation: utf8mb4_unicode_ci, matching every other table in this schema
-- (verified against the live DB via information_schema).

-- AlterTable
ALTER TABLE `UserPreferences`
  ADD COLUMN `pushEnabled` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `pushConsentedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `PushSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `p256dh` VARCHAR(191) NOT NULL,
    `auth` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT TRUE,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastSeen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PushSubscription_endpoint_key`(`endpoint`),
    INDEX `PushSubscription_userId_idx`(`userId`),
    INDEX `PushSubscription_active_idx`(`active`),
    PRIMARY KEY (`id`),
    CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
