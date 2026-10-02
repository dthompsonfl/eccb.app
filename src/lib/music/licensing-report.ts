/**
 * Copyright licensing / usage report.
 *
 * Answers the question a band director actually gets asked by a publisher or a
 * licensing body: "who has been issued which copyrighted work, and is it still
 * out?" It aggregates from data the app ALREADY records -- MusicAssignment rows
 * and their FileDownload history -- rather than introducing a second issuance
 * ledger that could drift from reality.
 *
 * Read-only: no authorization decisions live here.
 */

import { prisma } from '@/lib/db';
import { formatWatermarkTimestamp } from './watermark';

/** Filters accepted by the report. */
export interface LicensingReportFilters {
  /** Only include assignments from this date onwards. */
  since?: Date | null;
  /** Only include assignments up to this date. */
  until?: Date | null;
  /** Only include this member. */
  memberId?: string | null;
  /** Only include this piece. */
  pieceId?: string | null;
  /** Include assignments that have been returned. Default true. */
  includeReturned?: boolean;
}

/** One row: a copyrighted work issued to one member. */
export interface LicensingReportRow {
  memberId: string;
  memberName: string;
  memberEmail: string | null;
  pieceId: string;
  pieceTitle: string;
  composer: string | null;
  publisher: string | null;
  catalogNumber: string | null;
  copyrightYear: number | null;
  partName: string | null;
  copyNumber: number | null;
  status: string;
  assignedAt: string;
  pickedUpAt: string | null;
  returnedAt: string | null;
  dueDate: string | null;
  watermarkEnabled: boolean;
  /** Number of recorded deliveries of this piece's files. */
  downloadCount: number;
}

/** Aggregate counts, useful as a report header/summary. */
export interface LicensingSummary {
  totalWorks: number;
  totalMembers: number;
  totalIssued: number;
  currentlyIssued: number;
  returned: number;
  watermarkDisabledWorks: number;
}

export interface LicensingReport {
  generatedAt: string;
  rows: LicensingReportRow[];
  summary: LicensingSummary;
}

/** ISO-ish UTC stamp shared with the watermark so both agree on format. */
function stamp(date: Date | null | undefined): string | null {
  return date ? formatWatermarkTimestamp(date) : null;
}

const ACTIVE_STATUSES = ['ASSIGNED', 'PICKED_UP', 'BORROWED'] as const;

/**
 * Build the licensing report.
 *
 * Aggregates MusicAssignment (the authoritative issuance record) enriched with
 * member, piece, composer, publisher and copyright year, plus a count of
 * FileDownload rows per piece so the report also evidences delivery.
 */
export async function buildLicensingReport(
  filters: LicensingReportFilters = {}
): Promise<LicensingReport> {
  const includeReturned = filters.includeReturned ?? true;

  const assignments = await prisma.musicAssignment.findMany({
    where: {
      ...(filters.memberId ? { memberId: filters.memberId } : {}),
      ...(filters.pieceId ? { pieceId: filters.pieceId } : {}),
      ...(filters.since || filters.until
        ? {
            assignedAt: {
              ...(filters.since ? { gte: filters.since } : {}),
              ...(filters.until ? { lte: filters.until } : {}),
            },
          }
        : {}),
    },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
      piece: {
        select: {
          id: true,
          title: true,
          catalogNumber: true,
          copyrightYear: true,
          watermarkEnabled: true,
          composer: { select: { fullName: true } },
          publisher: { select: { name: true } },
        },
      },
    },
    orderBy: [{ assignedAt: 'desc' }],
  });

  const [downloads, files] = await Promise.all([
    prisma.fileDownload.groupBy({ by: ['fileId'], _count: { _all: true } }),
    prisma.musicFile.findMany({ select: { id: true, pieceId: true } }),
  ]);

  // Map fileId -> pieceId so downloads can be attributed to a work.
  const pieceIdByFileId = new Map(files.map((f) => [f.id, f.pieceId]));
  const downloadsByPiece = new Map<string, number>();
  for (const d of downloads) {
    const pieceId = pieceIdByFileId.get(d.fileId);
    if (!pieceId) continue;
    downloadsByPiece.set(pieceId, (downloadsByPiece.get(pieceId) ?? 0) + d._count._all);
  }

  const rows: LicensingReportRow[] = assignments
    .filter((a) => includeReturned || !a.returnedAt)
    .map((a) => ({
      memberId: a.member.id,
      memberName: `${a.member.firstName} ${a.member.lastName}`.trim(),
      memberEmail: a.member.email,
      pieceId: a.piece.id,
      pieceTitle: a.piece.title,
      composer: a.piece.composer?.fullName ?? null,
      publisher: a.piece.publisher?.name ?? null,
      catalogNumber: a.piece.catalogNumber,
      copyrightYear: a.piece.copyrightYear,
      partName: a.partName,
      copyNumber: a.copyNumber,
      status: a.status,
      assignedAt: stamp(a.assignedAt) ?? '',
      pickedUpAt: stamp(a.pickedUpAt),
      returnedAt: stamp(a.returnedAt),
      dueDate: stamp(a.dueDate),
      watermarkEnabled: a.piece.watermarkEnabled,
      downloadCount: downloadsByPiece.get(a.piece.id) ?? 0,
    }));

  const summary: LicensingSummary = {
    totalWorks: new Set(rows.map((r) => r.pieceId)).size,
    totalMembers: new Set(rows.map((r) => r.memberId)).size,
    totalIssued: rows.length,
    currentlyIssued: rows.filter(
      (r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status) && !r.returnedAt
    ).length,
    returned: rows.filter((r) => r.returnedAt !== null).length,
    watermarkDisabledWorks: new Set(
      rows.filter((r) => !r.watermarkEnabled).map((r) => r.pieceId)
    ).size,
  };

  return { generatedAt: formatWatermarkTimestamp(new Date()), rows, summary };
}

const CSV_COLUMNS: Array<keyof LicensingReportRow> = [
  'memberName',
  'memberEmail',
  'pieceTitle',
  'composer',
  'publisher',
  'catalogNumber',
  'copyrightYear',
  'partName',
  'copyNumber',
  'status',
  'assignedAt',
  'pickedUpAt',
  'returnedAt',
  'dueDate',
  'watermarkEnabled',
  'downloadCount',
];

/** Escape a CSV cell: quote when it contains a delimiter, quote or newline. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Render the report as CSV, with a leading generated-at line so a downloaded
 * copy is self-dating.
 */
export function licensingReportToCsv(report: LicensingReport): string {
  const header = CSV_COLUMNS.join(',');
  const lines = report.rows.map((row) =>
    CSV_COLUMNS.map((col) => csvCell(row[col])).join(',')
  );
  return [`# Generated ${report.generatedAt}`, header, ...lines].join('\n') + '\n';
}

/** Filename for the export, e.g. licensing-report-2026-10-01.csv. */
export function licensingReportFilename(now: Date = new Date()): string {
  const date = formatWatermarkTimestamp(now).slice(0, 10);
  return `licensing-report-${date}.csv`;
}