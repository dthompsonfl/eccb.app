import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { AssetsClient } from './assets-client';

export default async function AdminAssetsPage() {
  await requirePermission(CMS_VIEW_ALL);

  const [assets, stats] = await Promise.all([
    prisma.mediaAsset.findMany({
      orderBy: { uploadedAt: 'desc' },
      take: 100,
    }),
    prisma.mediaAsset.groupBy({
      by: ['mimeType'],
      _count: true,
    }),
  ]);

  const imageCount = stats
    .filter(s => s.mimeType.startsWith('image/'))
    .reduce((acc, s) => acc + s._count, 0);

  const documentCount = stats
    .filter(s => s.mimeType.startsWith('application/'))
    .reduce((acc, s) => acc + s._count, 0);

  const formattedAssets = assets.map(asset => ({
    id: asset.id,
    fileName: asset.fileName,
    fileSize: asset.fileSize,
    mimeType: asset.mimeType,
    title: asset.title,
    altText: asset.altText,
    caption: asset.caption,
    tags: asset.tags as string[] | null,
    width: asset.width,
    height: asset.height,
    uploadedAt: asset.uploadedAt.toISOString(),
    uploadedBy: asset.uploadedBy,
    url: `/api/assets/${asset.id}`,
    isImage: asset.mimeType.startsWith('image/'),
  }));

  return (
    <AssetsClient
      initialAssets={formattedAssets}
      stats={{
        total: assets.length,
        images: imageCount,
        documents: documentCount,
      }}
    />
  );
}
