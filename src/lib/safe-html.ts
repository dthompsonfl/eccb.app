import DOMPurify from 'dompurify';

/**
 * Strict whitelist for allowed tags and attributes to prevent XSS.
 */
export const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'pre',
  'blockquote', 'a', 'img', 'div', 'span', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'dl', 'dt', 'dd', 'sub', 'sup', 'del', 'ins'
];

export const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'name', 'target', 'rel',
  'width', 'height', 'align', 'valign'
];

/**
 * Sanitizes an HTML string using DOMPurify with a strict whitelist.
 * Works on both client and server side.
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') {
    // Server-side
    // We use a dynamic import for JSDOM to avoid bundling it in the client-side code
    // This is necessary because JSDOM depends on Node.js-only APIs.
    // However, in standard Next.js, top-level dynamic imports are not allowed in server components easily.
    // Instead, we can try to require it only if needed.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { JSDOM } = require('jsdom');
      const jsdomWindow = new JSDOM('').window;
      const purify = DOMPurify(jsdomWindow as unknown as Window);
      return purify.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      }) as string;
    } catch (e) {
      console.error('Failed to load jsdom for server-side sanitization', e);
      // Fallback: strip all tags if we can't sanitize safely on the server
      return html.replace(/<[^>]*>?/gm, '');
    }
  } else {
    // Client-side
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
    }) as string;
  }
}
