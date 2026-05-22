import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission, getUserRoles } from '@/lib/auth/permissions';
import { generateSecureDownloadUrl } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { z } from 'zod';

import { MUSIC_DOWNLOAD_ALL, MUSIC_DOWNLOAD_ASSIGNED } from '@/lib/auth/permission-constants';
// =============================================================================
// Request Validation
// =============================================================================

const DownloadUrlRequestSchema = z.object({
  key: z.string().min(1, 'Storage key is required'),
  expiresIn: z.number().min(60).max(86400).optional(), // 1 min to 24 hours
});

// =============================================================================
// Authorization Helpers
// =============================================================================

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
 * Check if user is authorized to download a specific file.
 */
async function checkDownloadAuthorization(
  userId: string,
  storageKey: string
): Promise<{ authorized: boolean; reason: string }> {
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
    return { authorized: true, reason: 'admin_access' };
  }
  
  // Check for music.download.all permission
  const hasDownloadAll = await checkUserPermission(userId, MUSIC_DOWNLOAD_ALL);
  if (hasDownloadAll) {
    return { authorized: true, reason: 'download_all_permission' };
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
    return { authorized: false, reason: 'file_not_found' };
  }
  
  // Check if file is public
  if (file.isPublic) {
    return { authorized: true, reason: 'public_file' };
  }
  
  // Check if user has music.download.assigned permission
  const hasDownloadAssigned = await checkUserPermission(userId, MUSIC_DOWNLOAD_ASSIGNED);
  
  if (!hasDownloadAssigned) {
    return { authorized: false, reason: 'no_download_permission' };
  }
  
  // Check if user is assigned to this piece
  const isAssigned = file.piece.assignments.length > 0;
  
  if (!isAssigned) {
    return { authorized: false, reason: 'not_assigned_to_piece' };
  }
  
  return { authorized: true, reason: 'assigned_to_piece' };
}

// =============================================================================
// Route Handler
// =============================================================================

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResponse = await applyRateLimit(request, 'files');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // Validate CSRF
  const csrfResult = validateCSRF(request);
  if (!csrfResult.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrfResult.reason },
      { status: 403 }
    );
  }

  // Check authentication
  const session = await getSession();
  if (!session?.user?.id) {
    logger.warn('Download URL request denied: not authenticated');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Parse and validate request body
    const body = await request.json();
    const validationResult = DownloadUrlRequestSchema.safeParse(body);
    
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validationResult.error.flatten() },
        { status: 400 }
      );
    }
    
    const { key, expiresIn } = validationResult.data;
    
    // Validate storage key format (prevent obvious attacks)
    if (key.includes('..') || key.includes('\0')) {
      logger.warn('Download URL request denied: invalid storage key', { 
        userId: session.user.id, 
        key,
      });
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }
    
    // Check authorization
    const authResult = await checkDownloadAuthorization(session.user.id, key);
    
    if (!authResult.authorized) {
      logger.warn('Download URL request denied', { 
        userId: session.user.id, 
        key,
        reason: authResult.reason,
      });
      
      return NextResponse.json(
        { error: 'Access denied', reason: authResult.reason },
        { status: 403 }
      );
    }
    
    // Generate secure download URL
    const downloadUrl = await generateSecureDownloadUrl(key, {
      expiresIn,
      userId: session.user.id,
    });
    
    logger.info('Download URL generated', { 
      userId: session.user.id, 
      key,
      reason: authResult.reason,
    });
    
    return NextResponse.json({
      url: downloadUrl,
      expiresIn: expiresIn || 3600,
    });
  } catch (error) {
    logger.error('Failed to generate download URL', { 
      error, 
      userId: session.user.id,
    });
    
    return NextResponse.json(
      { error: 'Failed to generate download URL' },
      { status: 500 }
    );
  }
}
