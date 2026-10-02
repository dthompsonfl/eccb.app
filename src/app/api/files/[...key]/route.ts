import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { Readable } from 'stream';

import { MUSIC_DOWNLOAD_ALL, MUSIC_DOWNLOAD_ASSIGNED } from '@/lib/auth/permission-constants';
import {
  authorizeMusicFileAccess,
  hasGlobalMusicAccess,
  resolveMusicFileScope,
} from '@/lib/music/access';
import {
  applyDeliveryWatermarkStream,
  needsWatermark,
  WatermarkError,
} from '@/lib/music/watermark-delivery';
// =============================================================================
// Authorization Helpers
// =============================================================================

interface AuthResult {
  authorized: boolean;
  reason: string;
  userId?: string;
  memberId?: string;
  /** Piece this delivery belongs to, when known. Used for watermarking. */
  pieceId?: string;
}

/**
 * Check if a file is public (can be downloaded without authentication).
 */
async function isFilePublic(storageKey: string): Promise<boolean> {
  const file = await prisma.musicFile.findFirst({
    where: { storageKey },
    select: { isPublic: true },
  });
  return file?.isPublic ?? false;
}

/**
 * Check if user is authorized to download a specific file.
 *
 * Mirrors POST /api/files/download-url exactly: same global-role short-circuit,
 * same permission gates, same assignment + part scoping via
 * @/lib/music/access. Keep the two in step — this route is the fallback path
 * and must never be the weaker one.
 */
async function checkDownloadAuthorization(
  userId: string,
  storageKey: string
): Promise<AuthResult> {
  // Get user's member record
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { member: true },
  });

  if (!user) {
    return { authorized: false, reason: 'User not found' };
  }

  // Library administrators: admins, directors, staff, librarians.
  if (await hasGlobalMusicAccess(userId)) {
    logger.info('Download authorized: admin access', { userId, storageKey });
    return {
      authorized: true,
      reason: 'admin_access',
      userId,
      memberId: user.member?.id,
    };
  }

  // Check for music.download.all permission
  const hasDownloadAll = await checkUserPermission(userId, MUSIC_DOWNLOAD_ALL);
  if (hasDownloadAll) {
    logger.info('Download authorized: download.all permission', { userId, storageKey });
    return {
      authorized: true,
      reason: 'download_all_permission',
      userId,
      memberId: user.member?.id,
    };
  }

  // Find the file record
  const file = await prisma.musicFile.findFirst({
    where: { storageKey },
  });

  if (!file) {
    logger.warn('Download denied: file not found', { userId, storageKey });
    return { authorized: false, reason: 'file_not_found' };
  }

  // Check if file is public
  if (file.isPublic) {
    logger.info('Download authorized: public file', { userId, storageKey });
    return {
      authorized: true,
      reason: 'public_file',
      userId,
      memberId: user.member?.id,
    };
  }

  // Check if user has music.download.assigned permission
  const hasDownloadAssigned = await checkUserPermission(userId, MUSIC_DOWNLOAD_ASSIGNED);

  if (!hasDownloadAssigned) {
    logger.warn('Download denied: no download permission', { userId, storageKey });
    return { authorized: false, reason: 'no_download_permission' };
  }

  // Assignment + part scoping (shared with the download-url route and Stand).
  const access = await authorizeMusicFileAccess(userId, storageKey);
  if (!access.allowed) {
    logger.warn('Download denied: not assigned to piece', {
      userId,
      storageKey,
      pieceId: access.pieceId,
    });
    return { authorized: false, reason: 'not_assigned_to_piece' };
  }

  logger.info('Download authorized: assigned to piece', {
    userId,
    storageKey,
    pieceId: access.pieceId,
  });

  return {
    authorized: true,
    reason: `assigned_${access.scope}`,
    userId,
    memberId: user.member?.id,
    pieceId: access.pieceId,
  };
}

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

  // Check if file is public (can be accessed without authentication)
  const isPublic = await isFilePublic(storageKey);
  
  // Check authentication
  const session = await getSession();
  
  // If not authenticated and file is not public, deny access
  if (!session?.user?.id && !isPublic) {
    logger.warn('Download denied: not authenticated');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let authResult: AuthResult;
    
    if (session?.user?.id) {
      // User is authenticated, check full authorization
      authResult = await checkDownloadAuthorization(session.user.id, storageKey);
    } else {
      // User is not authenticated but file is public
      authResult = { authorized: true, reason: 'public_file_anonymous' };
    }
    
    if (!authResult.authorized) {
      logger.warn('Download denied', { 
        userId: session?.user?.id, 
        storageKey,
        reason: authResult.reason,
      });
      
      return NextResponse.json(
        { error: 'Access denied', reason: authResult.reason },
        { status: 403 }
      );
    }
    
    // Get file record for logging
    const file = await prisma.musicFile.findFirst({
      where: { storageKey },
    });
    
    // Handle download based on storage driver
    const result = await downloadFile(storageKey);
    
    if (typeof result === 'string') {
      // S3: redirect to presigned URL
      logger.info('Redirecting to S3 presigned URL', { 
        userId: session?.user?.id, 
        storageKey,
      });
      
      // Log the download
      if (file) {
        await logDownload(file.id, authResult.userId, request, file.fileSize);
      }
      
      return NextResponse.redirect(result);
    }
    
    // LOCAL: stream the file
    const { stream, metadata } = result;

    // Watermark PDFs on the way out. This runs ONLY after authorization has
    // already succeeded above — it stamps bytes that are already proven
    // deliverable and never widens access. A stamping failure must not fall
    // back to the clean original, so it is caught and turned into a 500 below.
    let body: Uint8Array | null = null;
    let deliverySize = metadata.size;
    if (needsWatermark(metadata.contentType)) {
      const pieceId = authResult.pieceId ?? (await resolveMusicFileScope(storageKey))?.pieceId;
      if (pieceId) {
        try {
          const stamped = await applyDeliveryWatermarkStream({
            stream,
            contentType: metadata.contentType,
            pieceId,
            userId: authResult.userId,
          });
          body = stamped.bytes;
          deliverySize = stamped.size;
        } catch (error) {
          if (error instanceof WatermarkError) {
            logger.error('Refusing to deliver unstamped copyrighted PDF', {
              error,
              storageKey,
              userId: authResult.userId,
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
      await logDownload(file.id, authResult.userId, request, deliverySize);
    }

    // Convert to a Web stream, unless the file was already buffered to stamp it.
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
    
    logger.info('Streaming file', { 
      userId: session?.user?.id, 
      storageKey,
      contentType: metadata.contentType,
      size: deliverySize,
      watermarked: body !== null,
    });
    
    return new Response(webStream, {
      status: 200,
      headers,
    });
  } catch (error) {
    logger.error('Failed to download file', { 
      error, 
      userId: session?.user?.id, 
      storageKey,
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
