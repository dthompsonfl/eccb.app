-- Public CMS completion: sponsors, gallery, leadership profiles, and contact submissions.

CREATE TABLE `Sponsor` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `level` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'COMMUNITY', 'IN_KIND') NOT NULL DEFAULT 'BRONZE',
  `description` TEXT NULL,
  `websiteUrl` VARCHAR(191) NULL,
  `logoAssetId` VARCHAR(191) NULL,
  `logoUrl` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `startsAt` DATETIME(3) NULL,
  `endsAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedBy` VARCHAR(191) NULL,
  INDEX `Sponsor_level_idx`(`level`),
  INDEX `Sponsor_isActive_idx`(`isActive`),
  INDEX `Sponsor_sortOrder_idx`(`sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GalleryAlbum` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `isPublished` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `coverImageId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedBy` VARCHAR(191) NULL,
  UNIQUE INDEX `GalleryAlbum_slug_key`(`slug`),
  INDEX `GalleryAlbum_isPublished_idx`(`isPublished`),
  INDEX `GalleryAlbum_sortOrder_idx`(`sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GalleryImage` (
  `id` VARCHAR(191) NOT NULL,
  `albumId` VARCHAR(191) NULL,
  `assetId` VARCHAR(191) NULL,
  `imageUrl` VARCHAR(191) NULL,
  `title` VARCHAR(191) NULL,
  `altText` VARCHAR(191) NOT NULL,
  `caption` TEXT NULL,
  `isPublished` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedBy` VARCHAR(191) NULL,
  INDEX `GalleryImage_albumId_idx`(`albumId`),
  INDEX `GalleryImage_isPublished_idx`(`isPublished`),
  INDEX `GalleryImage_sortOrder_idx`(`sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `LeadershipProfile` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `role` VARCHAR(191) NOT NULL,
  `profileType` ENUM('DIRECTOR', 'BOARD', 'STAFF', 'VOLUNTEER') NOT NULL DEFAULT 'VOLUNTEER',
  `bio` TEXT NULL,
  `photoAssetId` VARCHAR(191) NULL,
  `photoUrl` VARCHAR(191) NULL,
  `email` VARCHAR(191) NULL,
  `isPublished` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedBy` VARCHAR(191) NULL,
  INDEX `LeadershipProfile_profileType_idx`(`profileType`),
  INDEX `LeadershipProfile_isPublished_idx`(`isPublished`),
  INDEX `LeadershipProfile_sortOrder_idx`(`sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ContactSubmission` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `subject` VARCHAR(191) NOT NULL,
  `message` LONGTEXT NOT NULL,
  `status` ENUM('NEW', 'READ', 'REPLIED', 'RESOLVED', 'ARCHIVED') NOT NULL DEFAULT 'NEW',
  `ipAddress` VARCHAR(191) NULL,
  `userAgent` VARCHAR(191) NULL,
  `responseNotes` TEXT NULL,
  `handledBy` VARCHAR(191) NULL,
  `handledAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `ContactSubmission_status_idx`(`status`),
  INDEX `ContactSubmission_createdAt_idx`(`createdAt`),
  INDEX `ContactSubmission_email_idx`(`email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `GalleryImage` ADD CONSTRAINT `GalleryImage_albumId_fkey` FOREIGN KEY (`albumId`) REFERENCES `GalleryAlbum`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
