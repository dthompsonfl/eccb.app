import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission, getUserRoles } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { Readable } from 'stream';

import { MUSIC_DOWNLOAD_ALL, MUSIC_DOWNLOAD_ASSIGNED } from '@/lib/auth/permission-constants';
// =============================================================================
// Authorization Helpers
// =============================================================================

interface AuthResult {
  authorized: boolean;
  reason: string;
  userId?: string;
  memberId?: string;
}

/**
 * Check if user has admin-level access (short-circuit for admins).
 */
async function isAdminUser(userId: string): Promise<boolean> {
  const roles = await getUserRoles(userId);
  return roles.some(role => 
    role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'LIBRARIAN'
  );
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
  
  // Admin short-circuit: admins can download any file
  if (await isAdminUser(userId)) {
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
    include: {
      piece: {
        include: {
          assignments: {
            where: {
              memberId: user.member?.id,
            },
          },
        },
      },
    },
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
  
  // Check if user is assigned to this piece
  const isAssigned = file.piece.assignments.length > 0;
  
  if (!isAssigned) {
    logger.warn('Download denied: not assigned to piece', { 
      userId, 
      storageKey,
      pieceId: file.pieceId,
    });
    return { authorized: false, reason: 'not_assigned_to_piece' };
  }
  
  logger.info('Download authorized: assigned to piece', { 
    userId, 
    storageKey,
    pieceId: file.pieceId,
  });
  
  return { 
    authorized: true, 
    reason: 'assigned_to_piece',
    userId,
    memberId: user.member?.id,
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
    
    // Log the download
    if (file) {
      await logDownload(file.id, authResult.userId, request, metadata.size);
    }
    
    // Convert Node.js stream to Web ReadableStream
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream;
    
    // Build response headers
    const headers = new Headers();
    headers.set('Content-Type', metadata.contentType);
    headers.set('Content-Length', String(metadata.size));
    headers.set('Content-Disposition', `attachment; filename="${file?.fileName || 'download'}"`);
    headers.set('Cache-Control', 'private, max-age=3600');
    
    // Add CORS headers for same-origin requests
    headers.set('Access-Control-Allow-Origin', 'same-origin');
    
    logger.info('Streaming file', { 
      userId: session?.user?.id, 
      storageKey,
      contentType: metadata.contentType,
      size: metadata.size,
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
