import { NextRequest } from 'next/server';
import { getEventProgram } from '@/lib/events/program-query';
import { buildProgramPdf } from '@/lib/events/program-pdf';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events/[id]/program.pdf
 *
 * Streams the generated concert program as a real PDF. Public: only published
 * events resolve, matching the public program page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  try {
    const program = await getEventProgram(id);
    if (!program) {
      return new Response('Not found', { status: 404 });
    }

    const bytes = await buildProgramPdf(program);
    const fileName = `${program.event.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-program.pdf`;

    // BodyInit wants an ArrayBuffer view; pdf-lib hands back a fresh Uint8Array.
    const body = new Uint8Array(bytes).buffer as ArrayBuffer;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logger.error('Failed to generate program PDF', { eventId: id, error });
    return new Response('Failed to generate program', { status: 500 });
  }
}
