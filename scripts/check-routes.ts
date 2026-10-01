/**
 * Link Integrity Check Script
 * 
 * This script enumerates all navigation links from sidebar components
 * and checks if the corresponding routes exist in the app directory.
 * 
 * Run with: npx tsx scripts/check-routes.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// Configuration
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_DIR = path.join(__dirname, '..', 'src', 'app');
const COMPONENTS_DIR = path.join(__dirname, '..', 'src', 'components');

interface NavLink {
  href: string;
  name: string;
  source: string;
}

interface RouteCheckResult {
  href: string;
  name: string;
  source: string;
  exists: boolean;
  routePath: string | null;
}

// =============================================================================
// Route Extraction from App Directory
// =============================================================================

function extractRoutesFromAppDir(dir: string, basePath: string = ''): Set<string> {
  const routes = new Set<string>();
  
  if (!fs.existsSync(dir)) {
    return routes;
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Skip special Next.js directories
      if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
        // Route group - continue without adding to path
        const subRoutes = extractRoutesFromAppDir(fullPath, basePath);
        subRoutes.forEach(r => routes.add(r));
      } else if (entry.name.startsWith('_') || entry.name === 'api') {
        // Skip private directories and API routes
        continue;
      } else if (entry.name.startsWith('[')) {
        // Dynamic route - add as parameterized
        const routeBase = entry.name.replace(/\[\.\.\.(.+)\]/g, ':$1*').replace(/\[(.+)\]/g, ':$1');
        const newBase = basePath + '/' + routeBase;
        routes.add(newBase);
        const subRoutes = extractRoutesFromAppDir(fullPath, newBase);
        subRoutes.forEach(r => routes.add(r));
      } else {
        // Regular directory
        const newBase = basePath + '/' + entry.name;
        routes.add(newBase);
        const subRoutes = extractRoutesFromAppDir(fullPath, newBase);
        subRoutes.forEach(r => routes.add(r));
      }
    } else if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
      // This is a valid route
      routes.add(basePath || '/');
    }
  }
  
  return routes;
}

// =============================================================================
// Link Extraction from Components
// =============================================================================

function extractLinksFromFile(filePath: string): NavLink[] {
  const links: NavLink[] = [];
  
  if (!fs.existsSync(filePath)) {
    return links;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);

  // Strip comments before scanning. Otherwise an href quoted inside an
  // explanatory comment (e.g. documenting a bug that was fixed) is reported
  // as a broken link, which trains people to ignore this check.
  const contentNoComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not https://
  
  // Match href attributes in JSX
  // Pattern matches: href="/path" or href={'/path'}
  const hrefPatterns = [
    /href=["']([^"']+)["']/g,
    /href=\{["']([^"']+)["']\}/g,
    /href=\{`([^`]+)`\}/g,
  ];
  
  // Match navigation arrays/objects
  // Pattern matches: { name: '...', href: '...' } or { label: '...', href: '...' }
  const navObjectPattern = /\{\s*(?:name|label):\s*['"`]([^'"`]+)['"`],\s*href:\s*['"`]([^'"`]+)['"`]/g;
  
  let match;
  
  // Extract from href attributes (comment-stripped source).
  for (const pattern of hrefPatterns) {
    while ((match = pattern.exec(contentNoComments)) !== null) {
      const href = match[1];
      // Skip external links, anchors, and dynamic links
      if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || href.includes('${')) {
        continue;
      }
      links.push({
        href,
        name: 'Unknown',
        source: fileName,
      });
    }
  }
  
  // Extract from navigation objects (comment-stripped source)
  while ((match = navObjectPattern.exec(contentNoComments)) !== null) {
    const name = match[1];
    const href = match[2];
    if (!href.startsWith('http') && !href.startsWith('#')) {
      links.push({
        href,
        name,
        source: fileName,
      });
    }
  }
  
  return links;
}

function extractLinksFromSidebarComponents(): NavLink[] {
  const links: NavLink[] = [];

  // Always check the known navigation shells explicitly so the report stays
  // readable, then walk the whole components tree so that a link living in
  // any other component (footer.tsx, a card grid, a CTA button) is still
  // validated. Hard-coding only the four nav shells is how /privacy, /terms
  // and /accessibility stayed linked-but-missing for so long: the public
  // footer was never scanned.
  const sidebarFiles = [
    path.join(COMPONENTS_DIR, 'admin', 'sidebar.tsx'),
    path.join(COMPONENTS_DIR, 'member', 'sidebar.tsx'),
    path.join(COMPONENTS_DIR, 'dashboard', 'sidebar.tsx'),
    path.join(COMPONENTS_DIR, 'public', 'navigation.tsx'),
    path.join(COMPONENTS_DIR, 'public', 'footer.tsx'),
  ];

  const seenFiles = new Set<string>();
  for (const file of sidebarFiles) {
    const resolved = path.resolve(file);
    if (seenFiles.has(resolved) || !fs.existsSync(resolved)) continue;
    seenFiles.add(resolved);
    links.push(...extractLinksFromFile(resolved));
  }

  // Walk every .tsx under src/components.
  const walkComponents = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walkComponents(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      const resolved = path.resolve(full);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      links.push(...extractLinksFromFile(resolved));
    }
  };
  walkComponents(COMPONENTS_DIR);

  // Deduplicate by href, keeping the first source seen.
  const seen = new Set<string>();
  return links.filter(link => {
    if (seen.has(link.href)) {
      return false;
    }
    seen.add(link.href);
    return true;
  });
}

// =============================================================================
// Route Matching
// =============================================================================

function routeMatches(href: string, routes: Set<string>): { matches: boolean; matchedRoute: string | null } {
  // Exact match
  if (routes.has(href)) {
    return { matches: true, matchedRoute: href };
  }

  // Check for dynamic route matches
  for (const route of routes) {
    // A catch-all route (`/:slug*`, from the public CMS `[...slug]` page)
    // compiles to a regex that matches EVERY path. Treating it as a match
    // made this checker unable to report any broken link at all, which is why
    // /privacy, /terms and /accessibility could be linked but missing for so
    // long while the gate reported "0 broken".
    //
    // A catch-all is a legitimate route shape, but it resolves through the CMS
    // at runtime, so it cannot validate a static link. It is therefore only
    // used as a last resort, and only after every explicit route has failed.
    if (route.includes('*')) {
      continue;
    }

    // Convert route pattern to regex
    const pattern = route.replace(/:[^/]+/g, '[^/]+');
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(href)) {
      return { matches: true, matchedRoute: route };
    }
  }

  // Nothing explicit matched. Report as broken rather than deferring to the
  // CMS catch-all: a static link in a component should point at a real route.
  return { matches: false, matchedRoute: null };
}

// =============================================================================
// Main Check Function
// =============================================================================

function checkLinkIntegrity(): {
  results: RouteCheckResult[];
  brokenLinks: RouteCheckResult[];
  validLinks: RouteCheckResult[];
  summary: {
    total: number;
    valid: number;
    broken: number;
  };
} {
  console.log('🔍 Checking link integrity...\n');
  
  // Extract routes from app directory
  console.log('📁 Extracting routes from app directory...');
  const routes = extractRoutesFromAppDir(APP_DIR);
  console.log(`   Found ${routes.size} routes\n`);
  
  // Debug: List all routes
  if (process.env.DEBUG === 'true') {
    console.log('   Routes found:');
    for (const route of Array.from(routes).sort()) {
      console.log(`   - ${route}`);
    }
    console.log('');
  }
  
  // Extract links from sidebar components
  console.log('🔗 Extracting links from sidebar components...');
  const links = extractLinksFromSidebarComponents();
  console.log(`   Found ${links.length} links\n`);
  
  // Check each link
  const results: RouteCheckResult[] = [];
  
  for (const link of links) {
    const { matches, matchedRoute } = routeMatches(link.href, routes);
    results.push({
      href: link.href,
      name: link.name,
      source: link.source,
      exists: matches,
      routePath: matchedRoute,
    });
  }
  
  // Separate valid and broken links
  const brokenLinks = results.filter(r => !r.exists);
  const validLinks = results.filter(r => r.exists);
  
  // Print results
  console.log('📊 Results:\n');
  
  if (validLinks.length > 0) {
    console.log(`✅ Valid links (${validLinks.length}):`);
    for (const link of validLinks) {
      console.log(`   ${link.href} (${link.source})`);
    }
    console.log('');
  }
  
  if (brokenLinks.length > 0) {
    console.log(`❌ Broken links (${brokenLinks.length}):`);
    for (const link of brokenLinks) {
      console.log(`   ${link.href} (${link.source}) - NOT FOUND`);
    }
    console.log('');
  }
  
  // Summary
  console.log('📈 Summary:');
  console.log(`   Total links: ${results.length}`);
  console.log(`   Valid: ${validLinks.length}`);
  console.log(`   Broken: ${brokenLinks.length}`);
  
  return {
    results,
    brokenLinks,
    validLinks,
    summary: {
      total: results.length,
      valid: validLinks.length,
      broken: brokenLinks.length,
    },
  };
}

// =============================================================================
// Run the check
// =============================================================================

const result = checkLinkIntegrity();

// Exit with error code if there are broken links
if (result.brokenLinks.length > 0) {
  console.log('\n⚠️  Link integrity check failed!');
  process.exit(1);
} else {
  console.log('\n✅ All links are valid!');
  process.exit(0);
}
