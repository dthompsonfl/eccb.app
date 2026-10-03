import type { MetadataRoute } from 'next';

import { absoluteUrl, getSiteUrl } from '@/lib/seo/site-url';

/**
 * `/robots.txt`
 *
 * Two jobs:
 *  1. Point crawlers at the sitemap, so the pages an editor published are
 *     actually discovered.
 *  2. Keep crawlers OUT of the member and admin areas. These are not secret by
 *     themselves — every one of them is behind authentication — but letting a
 *     crawler spend its budget on `/member/**` and `/admin/**` wastes crawl
 *     resources on pages that will always bounce to a login, and can surface
 *     member-only URLs in a search index.
 *
 * `/api/` is disallowed for the same reason: it is machine-facing, returns JSON,
 * and indexing it produces nothing but noise.
 *
 * `/login` is intentionally NOT disallowed. It is a real public page that
 * people search for, and disallowing a page that is linked from the footer is a
 * common mistake that can deindex legitimate content.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/admin/',
          '/member',
          '/member/',
          '/dashboard',
          '/setup',
          '/api/',
        ],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: getSiteUrl(),
  };
}
