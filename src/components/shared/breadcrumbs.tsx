'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items?: BreadcrumbItem[];
  homeHref?: string;
  homeLabel?: string;
}

// Route label mappings for auto-generation
const routeLabels: Record<string, string> = {
  admin: 'Admin',
  member: 'Member',
  members: 'Members',
  music: 'Music',
  events: 'Events',
  calendar: 'Calendar',
  announcements: 'Announcements',
  communications: 'Communications',
  reports: 'Reports',
  settings: 'Settings',
  pages: 'Pages',
  assets: 'Assets',
  sponsors: 'Sponsors',
  gallery: 'Gallery',
  leadership: 'Leadership',
  'contact-submissions': 'Contact Submissions',
  profile: 'Profile',
  notifications: 'Notifications',
  attendance: 'Attendance',
  new: 'New',
  edit: 'Edit',
};

export function Breadcrumbs({ 
  items, 
  homeHref = '/member',
  homeLabel = 'Dashboard',
}: BreadcrumbsProps) {
  const pathname = usePathname();

  // If items are provided, use them; otherwise auto-generate from path
  const breadcrumbItems = items || generateBreadcrumbs(pathname, homeHref, homeLabel);

  if (breadcrumbItems.length === 0) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {breadcrumbItems.map((item, index) => {
          const isLast = index === breadcrumbItems.length - 1;

          return (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {isLast || !item.href ? (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={item.href}>{item.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function generateBreadcrumbs(pathname: string, homeHref: string, homeLabel: string): BreadcrumbItem[] {
  const segments = pathname.split('/').filter(Boolean);
  const items: BreadcrumbItem[] = [];

  // Determine if we're in admin or member area
  const area = segments[0];
  const isAdmin = area === 'admin';
  const isMember = area === 'member';

  if (!isAdmin && !isMember) {
    return [];
  }

  // Add home/dashboard link
  items.push({
    label: homeLabel,
    href: homeHref,
  });

  // Process remaining segments
  let currentPath = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    currentPath += `/${segment}`;

    // Skip the first segment (admin/member) as we've already added home
    if (i === 0) continue;

    // Skip dynamic route segments (UUIDs, IDs)
    if (isDynamicSegment(segment)) {
      continue;
    }

    const label = routeLabels[segment] || formatLabel(segment);
    const isLast = i === segments.length - 1;

    items.push({
      label,
      href: isLast ? undefined : currentPath,
    });
  }

  return items;
}

function isDynamicSegment(segment: string): boolean {
  // Check if segment looks like a UUID or ID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const numericIdRegex = /^\d+$/;
  const cuidRegex = /^c[a-z0-9]{20,}$/i;
  
  return uuidRegex.test(segment) || numericIdRegex.test(segment) || cuidRegex.test(segment);
}

function formatLabel(segment: string): string {
  // Convert kebab-case or snake_case to Title Case
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Admin-specific breadcrumb component
export function AdminBreadcrumbs({ items }: { items?: BreadcrumbItem[] }) {
  return <Breadcrumbs items={items} homeHref="/admin" homeLabel="Dashboard" />;
}

// Member-specific breadcrumb component
export function MemberBreadcrumbs({ items }: { items?: BreadcrumbItem[] }) {
  return <Breadcrumbs items={items} homeHref="/member" homeLabel="Dashboard" />;
}
