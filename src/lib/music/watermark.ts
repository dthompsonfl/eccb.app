/**
 * Recipient watermarking for copyrighted sheet music.
 *
 * Handing a copy of copyrighted sheet music to a named member is a licensing
 * act, so the copy that leaves the building has to say whose copy it is. This
 * module produces that marking with pdf-lib (no external image service, no
 * round-trip through a third party) and is deliberately pure: it takes bytes in
 * and returns bytes out. It performs NO authorization and must never be used to
 * decide access -- @/lib/music/access is the only access authority.
 *
 * Security posture
 * ----------------
 * - DEFAULT ON. `watermarkEnabled` defaults to true in the schema, and
 *   {@link resolveWatermarkPolicy} treats an unknown/failed lookup as ENABLED.
 *   Turning it off requires the audited admin path in ./watermark-policy.
 * - FAIL CLOSED. If a PDF cannot be stamped (encrypted, corrupt, unsupported),
 *   {@link stampPdfWatermark} throws rather than returning the clean original.
 *   A delivery route must then refuse the bytes; it must not fall back to the
 *   unwatermarked file.
 * - The watermark text carries member name, organisation and an issue
 *   timestamp, which is the minimum needed to attribute a leaked copy.
 */

import { degrees, PDFFont, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/** Who the delivered copy is issued to. */
export interface WatermarkRecipient {
  /** Full name of the member receiving the copy, if known. */
  memberName: string | null;
  /** Account name/email when no Member record exists for the user. */
  accountLabel: string | null;
  /** Organisation the copy is licensed through. */
  organisation: string;
  /** Issue time (delivery time). */
  issuedAt: Date;
}

/** The visible marking, split for layout. */
export interface WatermarkText {
  /** Diagonal banner: "<org> — licensed copy". */
  banner: string;
  /** Attribution line: "Issued to <name> · <timestamp>". */
  attribution: string;
  /** Machine-readable trail appended for audit/forensics. */
  trail: string;
}

/**
 * Format an issue timestamp as a stable, sortable UTC string
 * (`YYYY-MM-DDTHH:MM:SSZ`).
 *
 * Built from UTC getters rather than `Intl.DateTimeFormat` on purpose: the
 * locale-formatted output varies by ICU build (some emit `24:00:00` at
 * midnight, others a comma instead of a space before the time), and this string
 * is written into copyrighted material and into a licensing report, so it must
 * not drift with the host's locale data.
 */
export function formatWatermarkTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

/** The label used to attribute a delivery to a person. */
export function recipientLabel(recipient: WatermarkRecipient): string {
  return recipient.memberName?.trim() || recipient.accountLabel?.trim() || 'Unidentified member';
}

/** Build the visible watermark text for a delivery. */
export function buildWatermarkText(recipient: WatermarkRecipient): WatermarkText {
  const issuedAt = formatWatermarkTimestamp(recipient.issuedAt);
  return {
    banner: `${recipient.organisation} — licensed copy`,
    attribution: `Issued to ${recipientLabel(recipient)}`,
    trail: `Issued to ${recipientLabel(recipient)} · ${recipient.organisation} · ${issuedAt}`,
  };
}

/** Raised when a PDF cannot be watermarked. Delivery must be refused. */
export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkError';
  }
}

/** True when the content type is one we can stamp into. */
export function isStampableContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type === 'application/pdf' || type === 'application/x-pdf';
}

const BANNER_SIZE = 34;
const ATTRIBUTION_SIZE = 13;
const TRAIL_SIZE = 8;
const DIAGONAL = degrees(32);

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Draw the watermark elements onto every page of a loaded document. */
function drawWatermark(
  doc: PDFDocument,
  font: PDFFont,
  fontBold: PDFFont,
  text: WatermarkText,
  title?: string | null
): void {
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();

    // Diagonal banner across the middle of the page.
    page.drawText(truncate(text.banner, 60), {
      x: width * 0.12,
      y: height * 0.52,
      size: BANNER_SIZE,
      font: fontBold,
      color: rgb(0.82, 0.82, 0.82),
      rotate: DIAGONAL,
      opacity: 0.35,
    });

    // Recipient, bottom-left so it survives a crop of the score itself.
    page.drawText(truncate(text.attribution, 70), {
      x: 24,
      y: height - 42,
      size: ATTRIBUTION_SIZE,
      font,
      color: rgb(0.55, 0.1, 0.1),
      opacity: 0.85,
    });

    // Machine-readable trail along the bottom edge.
    page.drawText(truncate(text.trail, 120), {
      x: 24,
      y: 18,
      size: TRAIL_SIZE,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity: 0.9,
    });

    if (title) {
      page.drawText(truncate(title, 60), {
        x: width - 24 - font.widthOfTextAtSize(truncate(title, 60), TRAIL_SIZE),
        y: 18,
        size: TRAIL_SIZE,
        font,
        color: rgb(0.45, 0.45, 0.45),
        opacity: 0.9,
      });
    }
  }
}

/**
 * Stamp the visible watermark onto every page of a PDF.
 *
 * @param bytes   original PDF bytes
 * @param text    watermark text from {@link buildWatermarkText}
 * @param title   piece title, shown small in the corner for traceability
 * @returns watermarked PDF bytes (never the input array; always a fresh copy)
 * @throws WatermarkError when the PDF cannot be loaded, stamped or encoded.
 *         The whole operation is guarded, not just the load step, because
 *         pdf-lib can also fail late (an unreadable page tree only surfaces on
 *         getPages()) and any such failure must still fail closed.
 */
export async function stampPdfWatermark(
  bytes: Uint8Array,
  text: WatermarkText,
  title?: string | null
): Promise<Uint8Array> {
  // Any failure here becomes a WatermarkError. The delivery routes catch that
  // and refuse the response: a copyrighted PDF we cannot stamp must never be
  // delivered clean.
  try {
    // `ignoreEncryption` lets us load an encrypted catalog so the stamp can be
    // written into it; we refuse to re-save it in a way that would weaken
    // protections we did not understand.
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (doc.getPages().length === 0) {
      throw new Error('no pages');
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    drawWatermark(doc, font, fontBold, text, title);
    return await doc.save({ useObjectStreams: false });
  } catch (error) {
    throw new WatermarkError(
      `Refusing to deliver an unstampable PDF: ${(error as Error).message}`
    );
  }
}

/**
 * Stamp a PDF, or pass the bytes through untouched for non-PDF content.
 * Non-PDF content cannot carry a PDF watermark; those deliveries are recorded
 * by the licensing report instead.
 */
export async function watermarkForDelivery(
  bytes: Uint8Array,
  contentType: string | null | undefined,
  text: WatermarkText,
  title?: string | null
): Promise<Uint8Array> {
  if (!isStampableContentType(contentType)) return bytes;
  return stampPdfWatermark(bytes, text, title);
}
