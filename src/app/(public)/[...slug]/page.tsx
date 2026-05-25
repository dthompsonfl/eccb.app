import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Calendar } from 'lucide-react';
import { CmsService } from '@/lib/services/cms.service';
import { formatDate } from '@/lib/date';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SafeHtml } from '@/components/ui/safe-html';
import { normalizePageContent } from '@/lib/cms/page-content';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

const RESERVED_SLUGS = [
  'about',
  'contact',
  'directors',
  'events',
  'gallery',
  'news',
  'policies',
  'sponsors',
  'admin',
  'member',
  'api',
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'verify-email',
  'forbidden',
  'offline',
];

export async function generateMetadata({ params }: PageProps) {
  const resolvedParams = await params;
  const slug = resolvedParams.slug.join('/');
  const page = await CmsService.getPageMetaBySlug(slug);

  if (!page) {
    return { title: 'Page Not Found' };
  }

  return {
    title: page.metaTitle || `${page.title} | Emerald Coast Community Band`,
    description: page.metaDescription,
  };
}

export default async function DynamicPage({ params }: PageProps) {
  const resolvedParams = await params;
  const slug = resolvedParams.slug.join('/');

  if (RESERVED_SLUGS.includes(resolvedParams.slug[0])) {
    notFound();
  }

  const page = await CmsService.getPageBySlug(slug, true);
  if (!page || page.status !== 'PUBLISHED') {
    notFound();
  }

  if (page.scheduledFor && page.scheduledFor > new Date()) {
    notFound();
  }

  const normalized = normalizePageContent(page.content);

  const renderContent = () => {
    if (page.rawMarkdown) {
      return (
        <div className="prose prose-neutral dark:prose-invert max-w-none">
          {page.rawMarkdown.split('\n').map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      );
    }

    if (normalized.html) {
      return (
        <SafeHtml
          className="prose prose-neutral dark:prose-invert max-w-none"
          html={normalized.html}
        />
      );
    }

    if (normalized.body.trim().length > 0) {
      return (
        <div className="prose prose-neutral dark:prose-invert max-w-none">
          {normalized.body.split('\n').map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      );
    }

    return <p className="text-muted-foreground">No content available.</p>;
  };

  return (
    <div className="w-full py-12 md:py-16">
      <article className="max-w-4xl mx-auto">
        <nav className="mb-6">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
        </nav>

        <header className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight mb-4">{page.title}</h1>

          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            {page.publishedAt && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {formatDate(page.publishedAt)}
              </div>
            )}

            {page.description && <Badge variant="outline">{page.description}</Badge>}
          </div>
        </header>

        <Card>
          <CardContent className="p-6 md:p-8">{renderContent()}</CardContent>
        </Card>

        {page.updatedAt && (
          <footer className="mt-8 text-sm text-muted-foreground text-center">
            Last updated on {formatDate(page.updatedAt)}
          </footer>
        )}
      </article>
    </div>
  );
}
