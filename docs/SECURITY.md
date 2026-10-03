# Security Documentation

This document outlines the security practices, tools, and procedures for the Emerald Coast Community Band (ECCB) platform.

## Table of Contents

1. [Security Audit Tools](#security-audit-tools)
2. [Dependency Management](#dependency-management)
3. [Security Headers](#security-headers)
4. [CSRF Protection](#csrf-protection)
5. [Rate Limiting](#rate-limiting)
6. [Authentication Security](#authentication-security)
7. [Input Validation](#input-validation)
8. [Reporting Security Issues](#reporting-security-issues)

## Security Audit Tools

### npm Scripts

The following npm scripts are available for security auditing:

```bash
# Run comprehensive security audit with detailed output
npm run security:audit

# Quick security check (exits with error if vulnerabilities found)
npm run security:check

# Attempt to automatically fix vulnerabilities
npm run security:fix

> **Note:** configuration for sensitive subsystems such as Smart Upload is stored exclusively in the database and managed via the admin UI; environment variables are consulted only during application bootstrap and never at runtime.  This design prevents accidental leakage of secrets or drift between deployments.
```

### Security Audit Script

The [`scripts/security-audit.sh`](../scripts/security-audit.sh) script provides:

- Comprehensive vulnerability scanning via `npm audit`
- Color-coded severity reporting (critical, high, moderate, low)
- Remediation suggestions
- Configurable audit levels and output formats

#### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIT_LEVEL` | `moderate` | Minimum severity to report (low, moderate, high, critical) |
| `OUTPUT_FORMAT` | `text` | Output format (text, json) |
| `EXIT_ON_VULN` | `true` | Exit with error code if vulnerabilities found |

Example:

```bash
AUDIT_LEVEL=high npm run security:audit
```

## Dependency Management

### Checking for Outdated Dependencies

```bash
# Check for outdated dependencies with detailed report
npm run deps:check

# Interactive dependency update
npm run deps:update
```

### Dependency Check Script

The [`scripts/dependency-check.ts`](../scripts/dependency-check.ts) script provides:

- Outdated package detection
- Vulnerability scanning integration
- Categorization by update type (major, minor, patch)
- Deprecation warnings

### Best Practices

1. **Regular Updates**: Run `npm run deps:check` weekly
2. **Security Fixes**: Run `npm run security:audit` before deployments
3. **Major Updates**: Review changelogs before updating major versions
4. **Lock File**: Always commit `package-lock.json` after updates
5. **Testing**: Run `npm test` after dependency updates

## Security Headers

Security headers are declared in **two** layers and both are live:

1. [`next.config.ts`](../next.config.ts) — `headers()` applies a header set to
   every route (`source: '/:path*'`), plus a narrower `Permissions-Policy`
   override for `/member/stand/:path*` and no-store cache headers on `/api/:path*`.
2. [`src/proxy.ts`](../src/proxy.ts) — `applySecurityHeaders()` re-applies the
   header set (including a full CSP) to every response the proxy handles.

| Header | Value | Applied by | Purpose |
|--------|-------|-----------|---------|
| `X-Content-Type-Options` | `nosniff` | both | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | both | Prevents clickjacking (stricter than `SAMEORIGIN`) |
| `X-XSS-Protection` | `1; mode=block` | both | XSS filter protection |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | both | Controls referrer information |
| `X-DNS-Prefetch-Control` | `off` | `src/proxy.ts` | Prevents DNS prefetch leaking navigated origins |
| `Permissions-Policy` | `camera=()`, `microphone=()`, `geolocation=()`, `payment=()` denied everywhere; `microphone=(self)` only on `/member/stand/:path*` | both | Limits browser features to least privilege |
| `Content-Security-Policy` | `default-src 'self'`; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `script-src 'self' 'unsafe-inline'`; `style-src 'self' 'unsafe-inline'` | both | Prevents XSS and injection |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | `next.config.ts` (production only) and `src/proxy.ts` (unconditional) | Forces HTTPS |

Two honest caveats about the CSP, so it is not over-read:

- `script-src` carries `'unsafe-inline'` because Next.js emits inline bootstrap
  scripts. `'unsafe-eval'` is **not** enabled unless `NEXT_ENABLE_UNSAFE_EVAL=true`.
- `Strict-Transport-Security` is set unconditionally by `src/proxy.ts`, so it is
  also emitted on plain-HTTP (LAN / Tailscale) origins. Browsers ignore HSTS
  received over HTTP, so this is inert there rather than a lockout — but it is an
  inconsistency between the two layers, not an intentional design.

## CSRF Protection

Cross-Site Request Forgery (CSRF) protection is implemented in [`src/lib/csrf.ts`](../src/lib/csrf.ts):

- Origin/Host header validation for all mutating requests (POST, PUT, DELETE, PATCH)
- Token generation for additional protection
- Applied to all state-changing API routes

### Protected Routes

- `/api/admin/users/*` - User management operations
- `/api/admin/jobs` - Job queue management
- `/api/admin/monitoring` - Monitoring operations
- `/api/assets/*` - Asset upload and management
- `/api/files/*` - File operations
- `/api/members` - Member operations
- `/api/attendance/bulk` - Bulk attendance
- `/api/events/rsvp` - RSVP operations

## Rate Limiting

Rate limiting is implemented in [`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts) using Redis-based sliding window algorithm.

### Rate Limit Configurations

| Endpoint Type | Limit | Window |
|--------------|-------|--------|
| Authentication | 5 requests | 1 minute |
| Contact Form | 5 requests | 1 hour |
| File Downloads | 30 requests | 1 minute |
| File Uploads | 10 requests | 1 minute |
| RSVP | 10 requests | 1 minute |
| General API | 100 requests | 1 minute |
| Password Reset | 3 per email, 5 per IP | 1 hour |
| Sign Up | 3 per IP | 1 hour |
| Sign In | 5 per IP | 1 minute |

### Auth-Specific Protections

- Progressive delays for failed authentication attempts
- Per-email and per-IP rate limiting for sensitive operations
- Brute force prevention for sign-in

## Authentication Security

### Session Management

- Secure session handling via Better Auth
- HTTP-only cookies to prevent XSS access
- Session expiration and renewal
- Session revocation capabilities

### Password Security

- Bcrypt hashing for password storage
- Password strength requirements (configurable in settings)
- Password reset with time-limited tokens
- Rate-limited reset attempts

### Two-Factor Authentication

2FA support is available and can be configured in admin settings.

## Input Validation

All user input is validated using Zod schemas:

### Server Actions

All server actions use Zod for input validation. See individual action files in:
- [`src/app/(admin)/admin/*/actions.ts`](../src/app/(admin)/admin/)
- [`src/app/(public)/contact/actions.ts`](../src/app/(public)/contact/actions.ts)

### API Routes

All API routes validate request bodies using Zod schemas. See:
- [`src/app/api/*/route.ts`](../src/app/api/)

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. **Do not** create a public GitHub issue
2. Email the development team with details
3. Include steps to reproduce if possible
4. Allow time for investigation and fix before disclosure

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

## Security Checklist

### Before Deployment

- [ ] Run `npm run security:audit` - no critical/high vulnerabilities
- [ ] Run `npm run deps:check` - review outdated packages
- [ ] Run `npm run setup` to configure and verify environment variables (recommended). Note: `npm run build` executes `scripts/setup-admin.sh` (prebuild) which validates required env vars and writes a masked summary to `./build/env-variables-check.txt`.
- [ ] Verify all environment variables are set
- [ ] Confirm HTTPS is enabled
- [ ] Test rate limiting is working
- [ ] Verify CSRF protection on all mutating routes

### Regular Maintenance

- Weekly: Run security audit
- Monthly: Review and update dependencies
- Quarterly: Review rate limit configurations
- Annually: Security audit by external team

## Related Documentation

- [DEPLOYMENT.md](../DEPLOYMENT.md) - Deployment security considerations
- [PERMISSIONS.md](../PERMISSIONS.md) - Authorization system documentation
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Overall system architecture
