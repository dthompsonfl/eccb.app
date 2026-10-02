-- Watermarking controls for copyrighted sheet music.
--
-- Delivery of a copyrighted work to a named member is a licensing act, so the
-- delivered copy must be traceable back to a recipient. `watermarkEnabled`
-- therefore defaults to TRUE: an un-watermarked delivery has to be a deliberate,
-- audited act by a library administrator, never the out-of-the-box behaviour.
--
-- The three companion columns record WHO turned it off, WHEN, and WHY, so a
-- licensing question months later can be answered from the row itself.

ALTER TABLE `MusicPiece`
  ADD COLUMN `watermarkEnabled` BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN `watermarkDisabledBy` VARCHAR(191) NULL,
  ADD COLUMN `watermarkDisabledAt` DATETIME(3) NULL,
  ADD COLUMN `watermarkDisabledReason` VARCHAR(500) NULL;
