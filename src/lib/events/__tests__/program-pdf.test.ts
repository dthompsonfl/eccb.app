import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { buildProgramPdf } from '../program-pdf';
import { buildProgramDocument, type ProgramItemInput } from '../program';

function item(overrides: Partial<ProgramItemInput> & { id: string }): ProgramItemInput {
  return {
    sortOrder: 0,
    pieceId: `piece-${overrides.id}`,
    title: `Title ${overrides.id}`,
    subtitle: null,
    composer: null,
    arranger: null,
    duration: 5,
    notes: null,
    performers: [],
    ...overrides,
  };
}

const event = {
  id: 'event-1',
  title: 'Spring Concert',
  isPublished: true,
  description: null,
  dateLabel: 'Saturday, May 3, 2026',
  timeLabel: '7:00 pm – 9:00 pm',
  venueLabel: 'Municipal Auditorium, Daphne',
  dressCode: null,
};

/**
 * pdf-lib Flate-compresses page content streams on save, so the drawn text is
 * only visible after inflating them. This pulls every stream out of the file
 * and inflates it, which is exactly what a PDF reader does before painting.
 */
function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const chunks: string[] = [];

  const streamPattern = /stream\r?\n/g;
  let match = streamPattern.exec(raw);
  while (match !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end !== -1) {
      const slice = Buffer.from(bytes.subarray(start, end), 'latin1');
      try {
        chunks.push(inflateSync(slice).toString('latin1'));
      } catch {
        // Not a flate stream (e.g. an image); nothing to read.
      }
    }
    streamPattern.lastIndex = end === -1 ? raw.length : end;
    match = streamPattern.exec(raw);
  }

  // pdf-lib writes each drawn string as a hex-encoded <...> Tj operand.
  return chunks
    .join('\n')
    .replace(/<([0-9a-fA-F]+)>\s*Tj/g, (_match, hex: string) =>
      Buffer.from(hex, 'hex').toString('latin1')
    );
}

describe('buildProgramPdf', () => {
  it('produces a valid PDF document', async () => {
    const bytes = await buildProgramPdf(buildProgramDocument(event, [item({ id: 'a' })]));
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');

    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(0);
    expect(reloaded.getTitle()).toBe('Spring Concert — Program');
  });

  it('embeds the pieces in the persisted order', async () => {
    const program = buildProgramDocument(event, [
      item({ id: 'a', sortOrder: 0, title: 'Fanfare' }),
      item({ id: 'b', sortOrder: 1, title: 'Symphony' }),
      item({ id: 'c', sortOrder: 2, title: 'Overture' }),
    ]);
    const bytes = await buildProgramPdf(program);
    const text = extractPdfText(bytes);

    expect(text).toContain('1. Fanfare');
    expect(text).toContain('2. Symphony');
    expect(text).toContain('3. Overture');
    expect(text.indexOf('1. Fanfare')).toBeLessThan(text.indexOf('2. Symphony'));
    expect(text.indexOf('2. Symphony')).toBeLessThan(text.indexOf('3. Overture'));
  });

  it('writes the lower-bound total and the unknown marker, never a made-up number', async () => {
    const program = buildProgramDocument(event, [
      item({ id: 'a', sortOrder: 0, title: 'Known Piece', duration: 6 }),
      item({ id: 'b', sortOrder: 1, title: 'Mystery Piece', duration: null }),
    ]);
    const text = extractPdfText(await buildProgramPdf(program));

    expect(text).toContain('Total running time: at least 6 min');
    expect(text).toContain('Unknown');
    expect(text).toContain('total is a minimum');
    expect(text).not.toContain('Total running time: 6 min');
  });

  it('paginates a long program instead of drawing off the page', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      item({ id: `em-${index}`, sortOrder: index, title: `Piece number ${index}` })
    );
    const bytes = await buildProgramPdf(buildProgramDocument(event, many));
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
  });

  it('credits performers with part and section', async () => {
    const program = buildProgramDocument(event, [
      item({
        id: 'a',
        title: 'Fanfare',
        performers: [
          { memberId: 'm1', name: 'Ada', partName: '1st Flute', sectionNames: ['Woodwinds'] },
        ],
      }),
    ]);
    const text = extractPdfText(await buildProgramPdf(program));
    expect(text).toContain('Ada');
    expect(text).toContain('1st Flute');
    expect(text).toContain('Woodwinds');
  });
});
