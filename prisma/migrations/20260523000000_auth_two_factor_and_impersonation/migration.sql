-- Additive migration for the Better Auth two-factor and admin-impersonation
-- plugins. Both plugins were configured in src/lib/auth/config.ts but had no
-- backing storage, so both features failed at runtime:
--   * two-factor/enable wrote to a `twoFactor` table that did not exist
--   * admin/impersonate-user wrote `session.impersonatedBy`, a column the
--     Prisma client did not declare
--
-- Deletion behaviour:
--   * twoFactor.userId -> User : ON DELETE CASCADE. A TOTP enrolment is an
--     authentication credential scoped to exactly one user; it must never
--     outlive that user, and must never block a user deletion.
--   * No FK on session.impersonatedBy. It is an audit pointer to the acting
--     admin, not an ownership edge. Making it a real FK would mean deleting
--     an admin cascades into destroying every impersonation session they
--     ever opened, which destroys the audit trail precisely when it matters.
--     The value is validated by Better Auth on write, and an orphaned pointer
--     is inert (the admin row is already gone).
--
-- Collation: utf8mb4_unicode_ci, matching every other table in this schema
-- (verified against the live DB via information_schema).

-- AlterTable
ALTER TABLE `session` ADD COLUMN `impersonatedBy` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `session_impersonatedBy_fkey` ON `session`(`impersonatedBy`);

-- CreateTable
CREATE TABLE `twoFactor` (
    `id` VARCHAR(191) NOT NULL,
    `secret` VARCHAR(191) NOT NULL,
    `backupCodes` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `twoFactor_userId_key`(`userId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `twoFactor_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;