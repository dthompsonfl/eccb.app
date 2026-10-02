import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { buildProgramLines, type ProgramDocument, type ProgramLine } from './program';

/**
 * Server-side PDF generation for a concert program.
 *
 * Uses the already-present `pdf-lib` dependency (no new package). The text
 * content comes from `buildProgramLines`, so the PDF and the HTML program
 * render from exactly the same ordered data and runtime label.
 */

const PAGE_WIDTH = 612; // US Letter at 72dpi
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const LINE_HEIGHT = 14;
const BOTTOM_LIMIT = MARGIN + 36;

interface StyleSpec {
  size: number;
  font: 'regular' | 'bold' | 'italic';
  gapAfter: number;
  color: ReturnType<typeof rgb>;
}

const STYLES: Record<ProgramLine['style'], StyleSpec> = {
  title: { size: 22, font: 'bold', gapAfter: 6, color: rgb(0.06, 0.16, 0.15) },
  heading: { size: 12, font: 'bold', gapAfter: 4, color: rgb(0.12, 0.29, 0.27) },
  body: { size: 11, font: 'regular', gapAfter: 2, color: rgb(0.12, 0.15, 0.16) },
  muted: { size: 9.5, font: 'italic', gapAfter: 1, color: rgb(0.35, 0.38, 0.4) },
  duration: { size: 9.5, font: 'regular', gapAfter: 8, color: rgb(0.2, 0.35, 0.33) },
};

function fontFor(fonts: Record<StyleSpec['font'], PDFFont>, key: StyleSpec['font']): PDFFont {
  return fonts[key];
}

/** Greedy word wrap against the printable width. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

/** Draw the program onto a freshly created document. */
export async function buildProgramPdf(program: ProgramDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };

  doc.setTitle(`${program.event.title} — Program`);
  doc.setSubject('Concert program');
  doc.setProducer('ECCB Management Platform');

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursorY = PAGE_HEIGHT - MARGIN;

  const newPage = (): void => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cursorY = PAGE_HEIGHT - MARGIN;
  };

  for (const line of buildProgramLines(program)) {
    const spec = STYLES[line.style];
    const font = fontFor(fonts, spec.font);
    const maxWidth = PAGE_WIDTH - MARGIN * 2;
    const wrapped = wrapText(line.text, font, spec.size, maxWidth);

    for (const segment of wrapped) {
      if (cursorY - LINE_HEIGHT < BOTTOM_LIMIT) newPage();
      cursorY -= LINE_HEIGHT;
      page.drawText(segment, {
        x: MARGIN,
        y: cursorY,
        size: spec.size,
        font,
        color: spec.color,
      });
    }
    cursorY -= spec.gapAfter;
  }

  return doc.save();
}
