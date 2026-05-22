import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile, deleteFile } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { Readable } from 'stream';

import { CMS_EDIT } from '@/lib/auth/permission-constants';
// =============================================================================
// Route Handler - GET (Download/View Asset)
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Apply rate limiting
  const rateLimitResponse = await applyRateLimit(request, 'files');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const { id } = await params;

    // Get asset from database
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
    });

    if (!asset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    // Check if user has permission to view
    // Public assets can be viewed by anyone
    // Private assets require CMS_VIEW_ALL or CMS_VIEW_PUBLIC permission
    const _session = await getSession();

    // For now, all CMS assets are considered public
    // In the future, we could add an `isPublic` field to MediaAsset

    // Handle download based on storage driver
    const result = await downloadFile(asset.storageKey);

    if (typeof result === 'string') {
      // S3: redirect to presigned URL
      logger.info('Redirecting to S3 presigned URL for asset', {
        assetId: asset.id,
        mimeType: asset.mimeType,
      });

      return NextResponse.redirect(result);
    }

    // LOCAL: stream the file
    const { stream, metadata } = result;

    // Convert Node.js stream to Web ReadableStream
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream;

    // Build response headers
    const headers = new Headers();
    headers.set('Content-Type', metadata.contentType);
    headers.set('Content-Length', String(metadata.size));

    // For images, allow inline display; for others, force download
    const isImage = asset.mimeType.startsWith('image/');
    if (isImage) {
      headers.set('Content-Disposition', `inline; filename="${asset.fileName}"`);
    } else {
      headers.set('Content-Disposition', `attachment; filename="${asset.fileName}"`);
    }

    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');

    logger.info('Streaming asset', {
      assetId: asset.id,
      mimeType: asset.mimeType,
      size: metadata.size,
    });

    return new Response(webStream, {
      status: 200,
      headers,
    });
  } catch (error) {
    logger.error('Failed to retrieve asset', { error });

    if (error instanceof Error && error.message === 'File not found') {
      return NextResponse.json({ error: 'Asset file not found' }, { status: 404 });
    }

    return NextResponse.json(
      { error: 'Failed to retrieve asset' },
      { status: 500 }
    );
  }
}

// =============================================================================
// Route Handler - DELETE
// =============================================================================

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check CMS edit permission
  const hasPermission = await checkUserPermission(session.user.id, CMS_EDIT);
  if (!hasPermission) {
    logger.warn('Asset delete denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: CMS edit permission required' }, { status: 403 });
  }

  try {
    const { id } = await params;

    // Get asset from database
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
    });

    if (!asset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    // Delete from storage
    try {
      await deleteFile(asset.storageKey);
    } catch (error) {
      // Log but continue - database record is the source of truth
      logger.warn('Failed to delete asset file from storage', {
        error,
        assetId: asset.id,
        storageKey: asset.storageKey,
      });
    }

    // Delete from database
    await prisma.mediaAsset.delete({
      where: { id },
    });

    logger.info('Asset deleted successfully', {
      userId: session.user.id,
      assetId: asset.id,
      fileName: asset.fileName,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete asset', { error, userId: session.user.id });

    return NextResponse.json(
      { error: 'Failed to delete asset' },
      { status: 500 }
    );
  }
}

// =============================================================================
// Route Handler - PATCH (Update metadata)
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check CMS edit permission
  const hasPermission = await checkUserPermission(session.user.id, CMS_EDIT);
  if (!hasPermission) {
    logger.warn('Asset update denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: CMS edit permission required' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const body = await request.json();

    // Validate input
    const { title, altText, caption, tags } = body;

    // Check if asset exists
    const existingAsset = await prisma.mediaAsset.findUnique({
      where: { id },
    });

    if (!existingAsset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    // Update asset
    const asset = await prisma.mediaAsset.update({
      where: { id },
      data: {
        title: title !== undefined ? title : existingAsset.title,
        altText: altText !== undefined ? altText : existingAsset.altText,
        caption: caption !== undefined ? caption : existingAsset.caption,
        tags: tags !== undefined ? tags : existingAsset.tags,
      },
    });

    logger.info('Asset updated successfully', {
      userId: session.user.id,
      assetId: asset.id,
    });

    return NextResponse.json({
      success: true,
      asset: {
        id: asset.id,
        fileName: asset.fileName,
        fileSize: asset.fileSize,
        mimeType: asset.mimeType,
        title: asset.title,
        altText: asset.altText,
        caption: asset.caption,
        tags: asset.tags,
        width: asset.width,
        height: asset.height,
        uploadedAt: asset.uploadedAt,
        url: `/api/assets/${asset.id}`,
      },
    });
  } catch (error) {
    logger.error('Failed to update asset', { error, userId: session.user.id });

    return NextResponse.json(
      { error: 'Failed to update asset' },
      { status: 500 }
    );
  }
}

// =============================================================================
// OPTIONS handler for CORS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
