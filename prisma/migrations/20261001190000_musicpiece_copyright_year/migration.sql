-- Smart Upload: give MusicPiece a canonical home for the extracted copyright year.
--
-- ExtractedMetadata.copyrightYear was already captured by the OCR/LLM pipeline and
-- retained in MusicFile.extractedMetadata, but had nowhere canonical to land, so a
-- librarian could not sort or report on it. Nullable with no default so existing
-- rows are unaffected and a missing year stays missing rather than becoming 0.

ALTER TABLE `MusicPiece` ADD COLUMN `copyrightYear` INTEGER NULL;
