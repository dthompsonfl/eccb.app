import type { MetadataRoute } from 'next';

import { prisma } from '@/lib/db';
import { publicPageVisibilityWhere } from '@/lib/cms/page-visibility';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * `/sitemap.xml` — every publicly reachable URL on the site.
 *
 * WHY THIS IS NOT JUST A STATIC LIST
 * ----------------------------------
 * The band's marketing pages are CMS content (`Page` rows), so hardcoding them
 * would go stale the moment an editor publishes a new page or unpublishes an
 * old one. This route queries the same rows the public site renders, through
 * the SAME visibility predicate (`publicPageVisibilityWhere`) the page
 * components use. A scheduled page that has not gone live yet is therefore
 * excluded here exactly as it is excluded from the site — that shared predicate
 * is what stops the sitemap advertising a draft or a future page to a crawler.
 *
 * Private surfaces (`/admin`, `/member`, `/dashboard`, `/login`, `/setup`) are
 * deliberately absent. Listing them would invite indexing of pages that either
 * 404 for the public or redirect to a login, which only damages the site's SEO
 * standing.
 */

/** Static public routes that always exist as real route files. */
const STATIC_PUBLIC_ROUTES: ReadonlyArray<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }> = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' },
  { path: '/about', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/directors', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/events', priority: 0.9, changeFrequency: 'weekly' },
  { path: '/gallery', priority: 0.7, changeFrequency: 'weekly' },
  { path: '/news', priority: 0.7, changeFrequency: 'daily' },
  { path: '/contact', priority: 0.6, changeFrequency: 'yearly' },
  { path: '/auditions', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/sponsors', priority: 0.5, changeFrequency: 'monthly' },
  // Legal and accessibility pages are linked from the public footer.
  { path: '/policies', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/accessibility', priority: 0.3, changeFrequency: 'yearly' },
];

/** Event detail pages are public, but only once published and not cancelled. */
const MAX_EVENTS_IN_SITEMAP = 500;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // The three sources are independent: one failing (e.g. the database is down
  // during a deploy) must not blank the whole sitemap, because the static
  // routes are still worth telling crawlers about.
  const [pagesResult, eventsResult] = await Promise.allSettled([
    prisma.page.findMany({
      where: publicPageVisibilityWhere(now),
      select: { slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_EVENTS_IN_SITEMAP,
    }),
    prisma.event.findMany({
      where: { isPublished: true, isCancelled: false, deletedAt: null },
      select: { id: true, updatedAt: true },
      orderBy: { startTime: 'desc' },
      take: MAX_EVENTS_IN_SITEMAP,
    }),
  ]);

  const entries: MetadataRoute.Sitemap = STATIC_PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  if (pagesResult.status === 'fulfilled') {
    for (const page of pagesResult.value) {
      // The CMS catch-all renders at the slug root, so `/about`, not `/page/about`.
      // Guard against an empty or `/`-only slug producing a duplicate of the home
      // page, which is already listed above.
      if (!page.slug || page.slug === '/') continue;
      entries.push({
        url: absoluteUrl(`/${page.slug}`),
        lastModified: page.updatedAt,
        changeFrequency: 'monthly',
        priority: 0.6,
      });
    }
  } else {
    console.error('[sitemap] failed to load CMS pages', pagesResult.reason);
  }

  if (eventsResult.status === 'fulfilled') {
    for (const event of eventsResult.value) {
      entries.push({
        url: absoluteUrl(`/events/${event.id}`),
        lastModified: event.updatedAt,
        changeFrequency: 'yearly',
        // Past events are archival; upcoming ones are the useful surface.
        priority: 0.5,
      });
    }
  } else {
    console.error('[sitemap] failed to load events', eventsResult.reason);
  }

  return entries;
}
