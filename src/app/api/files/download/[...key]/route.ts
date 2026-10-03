import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';
import { validateSignedToken, isTokenExpired } from '@/lib/signed-url';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { Readable } from 'stream';
import {
  applyDeliveryWatermarkStream,
  needsWatermark,
  WatermarkError,
} from '@/lib/music/watermark-delivery';
import { resolveMusicFileScope } from '@/lib/music/access';

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  // Apply rate limiting for file downloads
  const rateLimitResponse = await applyRateLimit(request, 'files');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // Get storage key from path
  const { key } = await params;
  const storageKey = key.join('/');
  
  // Validate storage key format (prevent obvious attacks)
  if (storageKey.includes('..') || storageKey.includes('\0')) {
    logger.warn('Download denied: invalid storage key', { storageKey });
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  // Get token from query string
  const token = request.nextUrl.searchParams.get('token');
  
  if (!token) {
    logger.warn('Download denied: missing token', { storageKey });
    return NextResponse.json({ error: 'Missing download token' }, { status: 401 });
  }

  // Validate the signed token
  const tokenPayload = validateSignedToken(token);
  
  if (!tokenPayload) {
    // Check if token is expired for better error message
    if (isTokenExpired(token)) {
      logger.warn('Download denied: token expired', { storageKey });
      return NextResponse.json({ error: 'Download link has expired' }, { status: 410 });
    }
    
    logger.warn('Download denied: invalid token', { storageKey });
    return NextResponse.json({ error: 'Invalid download token' }, { status: 403 });
  }
  
  // Verify token matches the requested file
  if (tokenPayload.key !== storageKey) {
    logger.warn('Download denied: token key mismatch', { 
      storageKey, 
      tokenKey: tokenPayload.key,
    });
    return NextResponse.json({ error: 'Token does not match requested file' }, { status: 403 });
  }

  try {
    // Get file record for logging
    const file = await prisma.musicFile.findFirst({
      where: { storageKey },
    });
    
    // Handle download based on storage driver
    const result = await downloadFile(storageKey);
    
    if (typeof result === 'string') {
      // S3: redirect to presigned URL (shouldn't happen with signed URLs, but fallback)
      logger.info('Redirecting to S3 presigned URL', { storageKey });
      
      // Log the download
      if (file) {
        await logDownload(file.id, tokenPayload.userId, request, file.fileSize);
      }
      
      return NextResponse.redirect(result);
    }
    
    // LOCAL: stream the file
    const { stream, metadata } = result;

    // Watermark PDFs on the way out, exactly as /api/files/[...key] does.
    // This route serves the same copyrighted scores through a signed-URL
    // token, so skipping the stamp here let any member holding a
    // music.download.assigned token retrieve a clean, untraceable copy.
    // Runs only after the token has been validated and bound to this key, and
    // a stamping failure must NOT fall back to the clean original.
    let body: Uint8Array | null = null;
    let deliverySize = metadata.size;
    if (needsWatermark(metadata.contentType)) {
      const pieceId = (await resolveMusicFileScope(storageKey))?.pieceId;
      if (pieceId) {
        try {
          const stamped = await applyDeliveryWatermarkStream({
            stream,
            contentType: metadata.contentType,
            pieceId,
            userId: tokenPayload.userId,
          });
          body = stamped.bytes;
          deliverySize = stamped.size;
        } catch (error) {
          if (error instanceof WatermarkError) {
            logger.error('Refusing to deliver unstamped copyrighted PDF', {
              error,
              storageKey,
              userId: tokenPayload.userId,
            });
            return NextResponse.json(
              { error: 'File could not be watermarked for delivery' },
              { status: 500 }
            );
          }
          throw error;
        }
      }
    }

    // Log the download
    if (file) {
      await logDownload(file.id, tokenPayload.userId, request, deliverySize);
    }

    // Convert Node.js stream to Web ReadableStream, unless already buffered
    // to stamp it.
    const webStream = body
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        })
      : (Readable.toWeb(stream as Readable) as ReadableStream);

    // Build response headers
    const headers = new Headers();
    headers.set('Content-Type', metadata.contentType);
    headers.set('Content-Length', String(deliverySize));
    headers.set('Content-Disposition', `attachment; filename="${file?.fileName || 'download'}"`);
    headers.set('Cache-Control', 'private, max-age=3600');
    
    // Add CORS headers for same-origin requests
    headers.set('Access-Control-Allow-Origin', 'same-origin');
    
    logger.info('Streaming file via signed URL', { 
      storageKey,
      contentType: metadata.contentType,
      size: metadata.size,
      userId: tokenPayload.userId,
    });
    
    return new Response(webStream, {
      status: 200,
      headers,
    });
  } catch (error) {
    logger.error('Failed to download file', { 
      error, 
      storageKey,
      userId: tokenPayload.userId,
    });
    
    if (error instanceof Error && error.message === 'File not found') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    
    return NextResponse.json(
      { error: 'Failed to retrieve file' },
      { status: 500 }
    );
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Log a file download to the database.
 */
async function logDownload(
  fileId: string,
  userId: string | undefined,
  request: NextRequest,
  bytesTransferred: number
): Promise<void> {
  try {
    await prisma.fileDownload.create({
      data: {
        fileId,
        userId,
        ipAddress: getClientIp(request),
        userAgent: request.headers.get('user-agent') || undefined,
        bytesTransferred,
      },
    });
    
    logger.info('Download logged', { fileId, userId, bytesTransferred });
  } catch (error) {
    logger.error('Failed to log download', { error, fileId, userId });
  }
}

/**
 * Get client IP address from request.
 */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }
  
  return 'unknown';
}
