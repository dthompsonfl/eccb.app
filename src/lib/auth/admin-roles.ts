/**
 * Canonical admin-console role matrix.
 *
 * There used to be two contradictory guards on nested admin routes:
 *
 *   src/app/(admin)/layout.tsx       requireRole('SUPER_ADMIN','ADMIN','DIRECTOR','STAFF','LIBRARIAN')
 *   src/app/(admin)/admin/layout.tsx requireRole('ADMIN')
 *
 * The outer guard admitted librarians; the inner one silently rejected them, so
 * every sidebar link under /admin (Members, Library, Uploads, Events, ...) 404'd
 * to /forbidden for exactly the role the library needs. Whichever list was
 * "correct", having two was the bug.
 *
 * Resolution: ONE role matrix, defined here, consumed by both layouts. The
 * console shell is admitted for every role that operates band administration;
 * fine-grained capability is then enforced per route by `requirePermission`.
 * That keeps the shell guard about "may you be in the admin console at all" and
 * pushes "may you do this specific thing" to the permission layer, which is the
 * model PERMISSIONS.md already documents.
 *
 * Consequence: this list is a SHELL gate, not an authorization grant. Individual
 * admin pages and server actions must still call requirePermission(). Pages with
 * no permission guard of their own rely solely on this shell gate, so any role
 * added here immediately gains those pages — add roles here only deliberately.
 */

// ─── Roles admitted to the admin console shell ───────────────────────────────

/**
 * Roles that may render the admin console layout.
 * Matches the sidebar's audience: everyone who administers the band.
 */
export const ADMIN_CONSOLE_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'DIRECTOR',
  'STAFF',
  'LIBRARIAN',
] as const;

export type AdminConsoleRole = (typeof ADMIN_CONSOLE_ROLES)[number];

/**
 * Roles that administer settings and role assignments.
 * Narrower than ADMIN_CONSOLE_ROLES on purpose — PERMISSIONS.md grants
 * `system.config` to SUPER_ADMIN only, and user/role management to admins.
 */
export const ADMIN_SETTINGS_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

/**
 * True when `roles` grants entry to the admin console shell.
 * SUPER_ADMIN is implicitly included (guards.requireRole treats it as a
 * universal bypass), so a bare SUPER_ADMIN passes with no other role present.
 */
export function isAdminConsoleRole(roles: readonly string[]): boolean {
  if (roles.includes('SUPER_ADMIN')) return true;
  return roles.some((role) =>
    (ADMIN_CONSOLE_ROLES as readonly string[]).includes(role)
  );
}

/**
 * True when `roles` may administer system settings / role assignment.
 */
export function isAdminSettingsRole(roles: readonly string[]): boolean {
  if (roles.includes('SUPER_ADMIN')) return true;
  return roles.some((role) => (ADMIN_SETTINGS_ROLES as readonly string[]).includes(role));
}