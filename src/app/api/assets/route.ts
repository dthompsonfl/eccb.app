import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
// =============================================================================
// Route Handler - GET (List Assets)
// =============================================================================

export async function GET(request: NextRequest) {
  // Check authentication
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check CMS view permission
  const hasPermission = await checkUserPermission(session.user.id, CMS_VIEW_ALL);
  if (!hasPermission) {
    logger.warn('Asset list denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: CMS view permission required' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);

    // Pagination
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);
    const offset = (page - 1) * limit;

    // Filters
    const mimeType = searchParams.get('mimeType');
    const search = searchParams.get('search');
    const tags = searchParams.get('tags');

    // Build where clause
    const where: Record<string, unknown> = {};

    if (mimeType) {
      if (mimeType === 'image') {
        where.mimeType = { startsWith: 'image/' };
      } else if (mimeType === 'document') {
        where.mimeType = { startsWith: 'application/' };
      } else {
        where.mimeType = mimeType;
      }
    }

    if (search) {
      where.OR = [
        { fileName: { contains: search } },
        { title: { contains: search } },
        { altText: { contains: search } },
        { caption: { contains: search } },
      ];
    }

    if (tags) {
      const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagArray.length > 0) {
        where.tags = { hasSome: tagArray };
      }
    }

    // Get total count
    const total = await prisma.mediaAsset.count({ where });

    // Get assets
    const assets = await prisma.mediaAsset.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      skip: offset,
      take: limit,
    });

    // Format response
    const formattedAssets = assets.map(asset => ({
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
      uploadedBy: asset.uploadedBy,
      url: `/api/assets/${asset.id}`,
      thumbnailUrl: asset.mimeType.startsWith('image/') ? `/api/assets/${asset.id}` : null,
    }));

    return NextResponse.json({
      assets: formattedAssets,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list assets', { error, userId: session.user.id });

    return NextResponse.json(
      { error: 'Failed to list assets' },
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
