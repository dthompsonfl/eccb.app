/**
 * Digital Music Stand E2E fixture: one MusicPiece + one MusicFile, backed by a
 * real, inked, multi-page PDF on local disk.
 *
 * WHY A FIXTURE IS NEEDED
 * -----------------------
 * The stand E2E specs open `/member/stand/library/<pieceId>` and then assert on
 * things only a genuinely rendered score can produce: a PDF canvas with a real
 * backing store, more than 1000 non-transparent pixels, a page count greater
 * than one, annotations scoped to a page, and a two-page spread whose right-hand
 * page actually paints. None of that can be satisfied by a database row alone:
 *
 *   - `src/app/(member)/member/stand/library/[pieceId]/page.tsx` calls
 *     `fileExists()` on every storage key and renders an "unavailable" error
 *     state when none resolve, so the PDF must be on disk under the SAME
 *     `LOCAL_STORAGE_PATH` the dev server reads.
 *   - The viewer streams the file through `/api/stand/files/...` and rasterises
 *     it with PDF.js, so the bytes must be a real PDF with visible ink.
 *
 * DETERMINISM AND IDEMPOTENCY
 * ---------------------------
 * `MusicPiece.catalogNumber` is `@unique`, so this fixture owns the sentinel
 * catalog number below and is looked up by it — never by a guessed cuid. Every
 * write is an upsert keyed on that sentinel (or on the file's own compound
 * unique), so `npm run db:seed` can be run any number of times without
 * duplicating a row or erroring. The PDF itself is produced by
 * `scripts/generate-stand-e2e-fixture-pdf.ts`, which pins its timestamps, so the
 * bytes are identical on every run and re-uploading is a no-op in practice.
 *
 * The specs resolve this piece's id at runtime (see `e2e/stand/_helpers.ts`),
 * which is why nothing here needs a hardcoded, machine-specific id.
 */
import type { PrismaClient } from '@prisma/client';

import { uploadFile } from '@/lib/services/storage';
import {
  buildStandE2EFixturePdf,
  STAND_E2E_FIXTURE_PAGE_COUNT,
} from '../scripts/generate-stand-e2e-fixture-pdf';

/**
 * Sentinel catalog number. Unique by schema constraint, so it is the stable
 * identity of this fixture and the key every upsert is guarded on.
 */
export const STAND_E2E_FIXTURE_CATALOG_NUMBER = 'E2E-FIXTURE-0001';

/**
 * Storage key of the fixture PDF, relative to `LOCAL_STORAGE_PATH`.
 *
 * Deliberately NOT derived from the piece's cuid: the key must be identical on
 * every machine and across re-seeds, so the file the app finds is predictable.
 */
export const STAND_E2E_FIXTURE_STORAGE_KEY =
  'music/e2e-stand-fixture/e2e-stand-fixture.pdf';

/**
 * Compound-unique discriminator for the fixture's MusicFile row
 * (`@@unique([pieceId, fileType, partFingerprintHash])`). A fixed, non-null
 * value is what makes the file upsertable; without it Prisma cannot address the
 * row and a second seed would try to insert a duplicate.
 */
const STAND_E2E_FIXTURE_FILE_FINGERPRINT =
  'e2efixture0000000000000000000000000000000000000000000stand'.slice(0, 64);

/** Composer shown on the fixture card, and the marker the specs match on. */
export const STAND_E2E_FIXTURE_COMPOSER = 'Stand Fixture Composer';

export interface SeedStandFixtureOptions {
  /** Skip regenerating the PDF (used when only the rows need repairing). */
  skipFileWrite?: boolean;
}

/**
 * Create or repair the stand E2E fixture. Safe to call on every seed.
 */
export async function seedStandE2EFixture(
  prisma: PrismaClient,
  options: SeedStandFixtureOptions = {},
): Promise<{ pieceId: string; storageKey: string; pageCount: number }> {
  // ── The file ────────────────────────────────────────────────────────────────
  // Written through the app's own storage service so the path resolution,
  // traversal validation and atomic write are identical to the ones Smart Upload
  // and the dev server use. A wrong path here shows up as the viewer's
  // "unavailable" state rather than as a seed error.
  if (!options.skipFileWrite) {
    const bytes = await buildStandE2EFixturePdf();
    await uploadFile(STAND_E2E_FIXTURE_STORAGE_KEY, Buffer.from(bytes), {
      contentType: 'application/pdf',
    });
  }

  // ── The composer ────────────────────────────────────────────────────────────
  // A Person row keyed by a fixed id, so the piece has a stable composer and the
  // library card is identifiable in the stand hub.
  const composer = await prisma.person.upsert({
    where: { id: 'e2e-fixture-composer' },
    update: { fullName: STAND_E2E_FIXTURE_COMPOSER },
    create: {
      id: 'e2e-fixture-composer',
      firstName: 'Stand',
      lastName: 'Fixture Composer',
      fullName: STAND_E2E_FIXTURE_COMPOSER,
    },
  });

  // ── The piece ───────────────────────────────────────────────────────────────
  // `catalogNumber` is the sentinel identity; everything else is refreshed on
  // re-seed so a corrected fixture title or page count reaches existing databases.
  const piece = await prisma.musicPiece.upsert({
    where: { catalogNumber: STAND_E2E_FIXTURE_CATALOG_NUMBER },
    update: {
      title: 'Avengers',
      composerId: composer.id,
      isArchived: false,
      deletedAt: null,
      notes:
        'Digital Music Stand E2E fixture. Generated by prisma/seed-stand-fixture.ts; ' +
        'the PDF is produced by scripts/generate-stand-e2e-fixture-pdf.ts.',
    },
    create: {
      catalogNumber: STAND_E2E_FIXTURE_CATALOG_NUMBER,
      title: 'Avengers',
      composerId: composer.id,
      isArchived: false,
      difficulty: 'GRADE_3',
      genre: 'Test Fixture',
      notes:
        'Digital Music Stand E2E fixture. Generated by prisma/seed-stand-fixture.ts; ' +
        'the PDF is produced by scripts/generate-stand-e2e-fixture-pdf.ts.',
    },
  });

  // ── The file row ────────────────────────────────────────────────────────────
  // `pageCount` is what the viewer and library page read to size and paginate the
  // score, so it must equal the PDF's real page count rather than being left NULL
  // (a NULL page count is exactly what previously left page navigation disabled).
  await prisma.musicFile.upsert({
    where: {
      pieceId_fileType_partFingerprintHash: {
        pieceId: piece.id,
        fileType: 'FULL_SCORE',
        partFingerprintHash: STAND_E2E_FIXTURE_FILE_FINGERPRINT,
      },
    },
    update: {
      fileName: 'e2e-stand-fixture.pdf',
      mimeType: 'application/pdf',
      storageKey: STAND_E2E_FIXTURE_STORAGE_KEY,
      pageCount: STAND_E2E_FIXTURE_PAGE_COUNT,
      isArchived: false,
    },
    create: {
      pieceId: piece.id,
      fileName: 'e2e-stand-fixture.pdf',
      fileType: 'FULL_SCORE',
      mimeType: 'application/pdf',
      storageKey: STAND_E2E_FIXTURE_STORAGE_KEY,
      // Size is cosmetic metadata; the real length is asserted by the generator.
      fileSize: 0,
      pageCount: STAND_E2E_FIXTURE_PAGE_COUNT,
      // MUST be set here as well as in the `where` clause: MySQL/MariaDB unique
      // indexes treat NULL as distinct from every other value, so a row inserted
      // with a NULL fingerprint would never be found by the upsert and a second
      // seed would silently add a duplicate file.
      partFingerprintHash: STAND_E2E_FIXTURE_FILE_FINGERPRINT,
      isPublic: false,
      isArchived: false,
      description: 'Digital Music Stand E2E fixture score (27 pages, generated).',
    },
  });

  // ── Reconciliation ──────────────────────────────────────────────────────────
  // Retire any MusicFile rows left on this piece that predate the fingerprint
  // above. An earlier revision of this fixture inserted its file without
  // `partFingerprintHash`, and because MySQL/MariaDB treats NULL as distinct in a
  // unique index, such a row is invisible to the upsert above — it would linger
  // forever and the library page would offer two identical PDFs. Deleting by
  // storage key is the honest repair, and it is a no-op on a clean database.
  await prisma.musicFile.deleteMany({
    where: {
      pieceId: piece.id,
      storageKey: STAND_E2E_FIXTURE_STORAGE_KEY,
      NOT: { partFingerprintHash: STAND_E2E_FIXTURE_FILE_FINGERPRINT },
    },
  });

  // ── Access ──────────────────────────────────────────────────────────────────
  // A seeded E2E login is normally the SUPER_ADMIN, who holds global music access
  // and therefore needs no assignment. Granting a whole-piece assignment to every
  // active member as well means the fixture is also usable when the suite is
  // pointed at a plain member account, which is what the library viewer's
  // authorization model requires for a piece-level score.
  const activeMembers = await prisma.member.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });
  for (const member of activeMembers) {
    const existing = await prisma.musicAssignment.findFirst({
      where: { pieceId: piece.id, memberId: member.id, partId: null },
      select: { id: true },
    });
    if (!existing) {
      await prisma.musicAssignment.create({
        data: {
          pieceId: piece.id,
          memberId: member.id,
          partName: 'Full Score (E2E fixture)',
          status: 'ASSIGNED',
          notes: 'Digital Music Stand E2E fixture assignment.',
        },
      });
    }
  }

  return {
    pieceId: piece.id,
    storageKey: STAND_E2E_FIXTURE_STORAGE_KEY,
    pageCount: STAND_E2E_FIXTURE_PAGE_COUNT,
  };
}
