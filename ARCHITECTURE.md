# Community Band Management Platform - System Architecture

## Executive Summary

This document outlines the production-grade architecture for a Community Band Management Platform designed to serve a real community band for 5-10 years. The platform combines a public CMS-driven website, secure internal portal, and comprehensive digital music library with role-based access control.

**Target Scale:**
- Single organization (one band)
- Hundreds to thousands of music files
- Dozens to low hundreds of members
- Volunteer-friendly UX

**Technology Foundation:**
- Next.js 16 (App Router)
- React 19
- TypeScript
- MariaDB/MySQL with Prisma ORM
- Better Auth for authentication
- Local Disk or S3-Compatible (Free Tier) for file storage
- Redis for caching and sessions

---

## 1. System Architecture Overview

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  Public Website  │  Member Portal  │  Admin Dashboard  │  PWA   │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NEXT.JS APPLICATION LAYER                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│   │   App Router │  │ Server       │  │  API Routes  │          │
│   │   (RSC)      │  │ Actions      │  │  (REST)      │          │
│   └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│   ┌────────────────────────────────────────────────────┐        │
│   │           Middleware Layer                         │        │
│   │  - Authentication                                  │        │
│   │  - Authorization (RBAC)                            │        │
│   │  - Rate Limiting                                   │        │
│   │  - Audit Logging                                   │        │
│   └────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SERVICE LAYER                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│    │   CMS    │ │  Music   │ │  Member  │ │  Event   │          │
│    │ Service  │ │ Library  │ │ Service  │ │ Service  │          │
│    └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│    │   Auth   │ │  Notif.  │ │  Search  │ │  Report  │          │
│    │ Service  │ │ Service  │ │ Service  │ │ Service  │          │
│    └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DATA LAYER                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│    │  MariaDB     │  │    Redis     │  │ Free Storage │         │
│    │  (Primary)   │  │  (Cache)     │  │(Local/S3Comp)│         │
│    └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Core Design Principles

1. **Domain-Driven Design**: Clear separation of concerns with bounded contexts
2. **Security by Default**: All routes require explicit authorization
3. **Audit Everything**: Comprehensive logging for accountability
4. **Fail Gracefully**: Graceful degradation and error handling
5. **Performance**: Edge caching, CDN delivery, optimistic updates
6. **Accessibility**: WCAG 2.1 AA compliance throughout
7. **Resilient Under Intermittency**: Stand sync falls back from WebSocket to
   polling; OCR and LLM steps degrade to a lower-confidence result that forces
   human review rather than committing unverified data.
   *Not yet offline-first:* there is no working PWA. `public/sw.js`
   self-unregisters and the manifest uses `display: "browser"`, so no music is
   cached for offline use. Treat offline access as unimplemented.

---

## 2. Domain Boundaries

### 2.1 Core Domains

#### **Public Content Domain**
- Manages public-facing website content
- No authentication required (read-only)
- CMS-driven pages, events, news
- **Bounded Context**: Public website pages, media, SEO

#### **Authentication & Identity Domain**
- User accounts, sessions, permissions
- Password management, OAuth, MFA
- Role and permission management
- **Bounded Context**: Users, roles, sessions, authentication methods

#### **Member Management Domain**
- Member profiles, instruments, sections
- Lifecycle management (active, inactive, alumni)
- Emergency contacts, availability
- **Bounded Context**: Members, instruments, sections, profiles

#### **Music Library Domain** (Core)
- Digital music catalog and files
- Metadata management, search, filtering
- Part assignment and distribution
- Access control and download tracking
- **Bounded Context**: Music pieces, files, parts, composers, assignments

#### **Events & Rehearsals Domain**
- Schedule management, locations
- Attendance tracking
- Music assignments per event
- Performance logistics
- **Bounded Context**: Concerts, rehearsals, venues, attendance

#### **Communications Domain**
- Announcements, notifications
- In-app messaging
- Email integration
- Push notifications
- **Bounded Context**: Messages, announcements, notifications, channels

#### **Administration Domain**
- Configuration management
- Reporting and analytics
- Audit logs
- System health monitoring
- **Bounded Context**: Settings, reports, logs, analytics

### 2.2 Cross-Cutting Concerns

- **Authorization**: Role-based access control (RBAC) applied across all domains
- **Audit Logging**: All mutations tracked with user, timestamp, and changes
- **Search**: Full-text search across multiple domains
- **File Storage**: Unified file management service
- **Notifications**: Cross-domain notification system

---

## 3. Technology Stack Rationale

### 3.1 Frontend

**Next.js 16 (App Router)**
- Server-side rendering for public pages (SEO)
- Server components reduce client-side JavaScript
- Streaming and Suspense for progressive enhancement
- Built-in API routes
- Edge middleware for auth/rate limiting
- Incremental Static Regeneration for public content

**React 19**
- Latest features: Server Components, Actions
- Improved performance and DX
- Strong ecosystem

**TypeScript**
- Type safety reduces runtime errors
- Better IDE support and refactoring
- Self-documenting code

**Tailwind CSS + Radix UI**
- Utility-first CSS for rapid development
- Accessible primitives from Radix
- Design system consistency

**GSAP**
- Retained from existing codebase for animations
- High-performance scroll-driven animations

### 3.2 Backend

**MariaDB/MySQL**
- ACID compliance for financial/attendance records
- Complex queries for reporting
- JSON support for flexible metadata
- Full-text search built-in
- Mature, battle-tested
- Excellent tooling (pgAdmin, pg_dump)

**Prisma ORM**
- Type-safe database access
- Migration management
- Excellent TypeScript integration
- Query builder prevents SQL injection

**Better Auth**
- Modern, lightweight auth library
- Support for email/password, OAuth, magic links
- Session management
- MFA support
- Framework-agnostic

**Redis**
- Session storage
- Cache layer (reduce DB load)
- Rate limiting counters
- Real-time features (pub/sub)

**Local Disk or S3-Compatible (Free Tier)**
- Scalable object storage for music PDFs
- Local storage for zero-cost self-hosting
- S3-compatible cloud (e.g., Backblaze B2 10GB Free Tier) for durable cloud storage
- Signed URLs (S3) or secure stream serving (Local)
- Versioning support
- Lifecycle policies
- CDN integration (optional)

### 3.3 Infrastructure

**Vercel or Self-Hosted**
- Vercel: Zero-config deployment, edge network, preview deployments
- Self-Hosted: Full control, cost optimization for larger scale

**GitHub Actions**
- CI/CD pipeline
- Automated testing
- Deployment automation

**MariaDB/MySQL Hosting**
- Vercel MariaDB, Supabase, or Railway
- Automated backups
- Point-in-time recovery

**Redis Hosting**
- Upstash (serverless Redis)
- Or self-hosted Redis

---

## 4. Security Architecture

### 4.1 Authentication Flow

```
User Login
    ↓
Better Auth validates credentials
    ↓
Session created (Redis)
    ↓
JWT or session cookie issued
    ↓
Subsequent requests include session token
    ↓
Middleware validates session
    ↓
User context available in RSC/API routes
```

### 4.2 Authorization Model (RBAC)

**Roles Hierarchy:**
```
Super Admin
    └── Admin
        └── Director/Staff
            ├── Section Leader
            ├── Librarian
            └── Musician
```

**Permission Examples:**
- `music.view.all` - View all music
- `music.view.assigned` - View only assigned music
- `music.upload` - Upload new music
- `music.edit` - Edit metadata
- `music.delete` - Delete music
- `member.view.all` - View all members
- `member.edit` - Edit member profiles
- `event.create` - Create events
- `attendance.mark` - Mark attendance
- `cms.edit` - Edit CMS content
- `cms.publish` - Publish content

**Implementation:**
- Permissions stored in database
- Checked in middleware and server actions
- UI elements conditionally rendered based on permissions
- API routes enforce permissions server-side

### 4.3 Data Security

1. **File Access**
   - Music PDFs stored in private storage containers (local or cloud)
   - Access via signed URLs (expiring links)
   - Download logging for audit trail
   - Optional watermarking with member ID

2. **Data Encryption**
   - HTTPS everywhere (TLS 1.3)
   - Database connections encrypted
   - Sensitive fields encrypted at rest (PII)
   - Environment variables for secrets

3. **Rate Limiting**
   - Per-IP limits on public endpoints
   - Per-user limits on authenticated endpoints
   - Progressive backoff for repeated failures

4. **Input Validation**
   - Zod schemas for all inputs
   - Sanitization of user content
   - CSRF tokens on mutations
   - SQL injection prevention (Prisma)
   - XSS prevention (React escaping)

### 4.4 Audit Logging

All mutations logged with:
- User ID and name
- Timestamp
- Action type (create/update/delete)
- Entity type and ID
- Old and new values (JSON diff)
- IP address
- User agent

Logs queryable via admin dashboard, exportable for compliance.

---

## 5. Performance Strategy

### 5.1 Caching Layers

**Edge Caching (CDN)**
- Public pages cached at edge
- Stale-while-revalidate pattern
- Cache purging on content updates

**Application Cache (Redis)**
- Frequently accessed data (member lists, music catalog)
- Query result caching
- TTL-based invalidation

**Database Query Optimization**
- Indexes on frequently queried fields
- Connection pooling
- Read replicas for reporting

### 5.2 Bundle Optimization

- Server Components for static content
- Code splitting per route
- Dynamic imports for heavy components (PDF viewer)
- Image optimization (Next.js Image)
- Font subsetting

### 5.3 Progressive Enhancement

- Core functionality works without JavaScript
- Forms submit via Server Actions
- Optimistic UI updates
- Loading states with Suspense

---

## 6. Scalability Considerations

### 6.1 Database Scaling

**Current Scale (Years 1-3)**
- Single MariaDB/MySQL instance
- 10-100 GB storage
- Vertical scaling as needed

**Future Scale (Years 4-10)**
- Read replicas for reporting
- Partitioning large tables (audit logs)
- Archived data moved to cold storage

### 6.2 File Storage Scaling

- Local disk scales with server capacity; S3-Compatible cloud scales infinitely
- Lifecycle policies: move old versions to Glacier
- CDN for music file delivery

### 6.3 Application Scaling

- Stateless application (sessions in Redis)
- Horizontal scaling via load balancer
- Background jobs via queue (BullMQ)

---

## 7. Disaster Recovery

### 7.1 Backup Strategy

**Database:**
- Automated daily backups (provider-managed)
- Point-in-time recovery (7-30 days)
- Weekly manual exports to S3

**File Storage:**
- S3 versioning enabled (cloud) or filesystem snapshots (local)
- Cross-region replication (optional for cloud)
- Periodic off-site sync for local storage

**Application Code:**
- Git repository (GitHub)
- Infrastructure as code (Terraform/Pulumi)

### 7.2 Recovery Procedures

**Data Loss:**
- Restore from latest backup
- Replay transaction logs if available

**Accidental Deletion:**
- Soft deletes with `deletedAt` timestamp
- Admin can restore within 30 days

**Security Breach:**
- Revoke all sessions
- Force password resets
- Audit log review
- Incident report

---

## 8. Monitoring & Observability

### 8.1 Application Monitoring

- **Error Tracking**: Sentry or similar
- **Performance**: Vercel Analytics or New Relic
- **Uptime**: Pingdom or UptimeRobot
- **Logs**: Structured JSON logs (Winston/Pino)

### 8.2 Metrics

- Request latency (p50, p95, p99)
- Error rates by endpoint
- Database query performance
- Cache hit rates
- File download counts
- Active user sessions

### 8.3 Alerts

- Error rate > 5%
- Response time > 2s
- Database connection pool exhausted
- Disk space > 80%
- Failed backup

---

## 9. Development Workflow

### 9.1 Environments

- **Local**: Docker Compose (MariaDB + Redis)
- **Development**: Vercel preview deployments
- **Staging**: Production-like environment
- **Production**: Main branch deployments

### 9.2 CI/CD Pipeline

```
Push to branch
    ↓
Run linting (ESLint)
    ↓
Run type checking (TypeScript)
    ↓
Run tests (Vitest)
    ↓
Build application
    ↓
Deploy to preview (PR branches)
    ↓
Manual approval
    ↓
Deploy to production (main branch)
    ↓
Run smoke tests
    ↓
Notify team (Slack/Email)
```

### 9.3 Database Migrations

- Prisma migrations tracked in Git
- Migration review in PRs
- Automated migration on deploy
- Rollback plan for each migration

---

## 10. Accessibility Strategy

### 10.1 WCAG 2.1 AA Compliance

- **Perceivable**:
  - Alt text for all images
  - Captions for audio/video
  - Sufficient color contrast (4.5:1 for text)
  - Text resizable to 200%

- **Operable**:
  - Keyboard navigation for all features
  - No keyboard traps
  - Skip links for navigation
  - Focus indicators visible
  - No time limits on forms

- **Understandable**:
  - Clear, consistent navigation
  - Form labels and error messages
  - Predictable interactions
  - Input assistance

- **Robust**:
  - Valid HTML
  - ARIA landmarks
  - Screen reader testing

### 10.2 Testing

- Automated accessibility testing (axe-core)
- Manual testing with screen readers (NVDA, VoiceOver)
- Keyboard-only navigation testing
- Color blindness simulation

---

## 11. Long-Term Maintainability

### 11.1 Code Organization

```
src/
├── app/                    # Next.js App Router
│   ├── (public)/          # Public routes (no auth)
│   ├── (member)/          # Member routes
│   ├── (admin)/           # Admin routes
│   └── api/               # API routes
├── components/            # React components
│   ├── ui/               # Design system primitives
│   ├── forms/            # Form components
│   └── layouts/          # Layout components
├── lib/                   # Core utilities
│   ├── auth/             # Authentication logic
│   ├── db/               # Database utilities (Prisma)
│   ├── services/         # Business logic services
│   ├── utils/            # Helper functions
│   └── constants/        # Constants and config
├── types/                 # TypeScript type definitions
├── middleware.ts          # Next.js middleware
└── instrumentation.ts     # OpenTelemetry (observability)
```

### 11.2 Documentation Standards

- **Code Comments**: Explain "why", not "what"
- **JSDoc**: For public APIs and utilities
- **README**: Per major directory
- **ADRs**: Architecture Decision Records for major choices
- **Runbooks**: Operational procedures
- **API Documentation**: OpenAPI/Swagger spec

### 11.3 Testing Strategy

- **Unit Tests**: Services and utilities (80%+ coverage)
- **Integration Tests**: API routes and Server Actions
- **E2E Tests**: Critical user flows (Playwright)
- **Performance Tests**: Load testing music downloads
- **Accessibility Tests**: Automated and manual

### 11.4 Dependency Management

- Regular dependency updates (Dependabot)
- Security vulnerability scanning
- License compliance checking
- Minimal dependencies (reduce bloat)

---

## 12. Migration from Current Vite + React

### 12.1 Migration Strategy

**Phase 1: New Next.js Foundation**
- Create new Next.js 16 project
- Set up database and auth
- Implement core services

**Phase 2: Backend Features**
- Build all backend functionality (CMS, music library, etc.)
- Develop admin and member portals

**Phase 3: Frontend Migration**
- Port existing React components to Next.js
- Maintain GSAP animations
- Adapt styling to Next.js structure

**Phase 4: Parallel Deployment**
- Deploy Next.js app to new domain/subdomain
- Test thoroughly
- Gradual traffic migration

**Phase 5: Cutover**
- DNS switch to new app
- Redirect old URLs
- Monitor for issues

### 12.2 Content Preservation

- Export existing content to JSON
- Import into new CMS
- Verify all pages and assets
- Set up redirects for changed URLs

---

## 13. Total Cost of Ownership (TCO) Estimate

### 13.1 Year 1 Costs

**Development**
- Initial build: ~500-800 hours (outsourced or volunteer)

**Hosting (Annual)**
- Vercel Pro: $240/year
- MariaDB/MySQL (Supabase): $300/year
- Redis (Upstash): $120/year
- S3 Storage (Free Tier): $0/year
- CDN: Included with Vercel
- **Total: ~$660/year**

**Self-Hosted Alternative:**
- Managed MariaDB/MySQL: $300/year
- Redis: Included in VPS
- Storage (Local Disk): $0/year
- **Total: ~$540/year**

### 13.2 Years 2-10 Costs

- Hosting scales linearly with data
- Maintenance: ~50-100 hours/year
- Feature additions: As needed
- Total annual: $1,000-$2,000

---

## 14. Success Metrics

The platform is successful if:

1. **Operational Efficiency**
   - Directors spend 50% less time on music distribution
   - Attendance tracking automated (save 2 hours/rehearsal)
   - Event planning streamlined

2. **User Adoption**
   - 90%+ of musicians use the platform
   - 80%+ of music downloads happen digitally
   - Positive feedback from librarians and directors

3. **Reliability**
   - 99.5% uptime
   - < 2 second page load times
   - Zero data loss incidents

4. **Maintainability**
   - New features added without breaking existing ones
   - Code changes reviewed and merged within 1 week
   - Technical debt remains manageable

5. **Accessibility**
   - WCAG 2.1 AA compliant
   - Positive feedback from users with disabilities

---

## 15. Conclusion

This architecture provides a solid foundation for a Community Band Management Platform that can serve a real band for 5-10 years. Key strengths:

- **Clear domain boundaries** make the system understandable
- **Role-based permissions** ensure security and privacy
- **Music library as first-class** reflects real workflows
- **Scalable infrastructure** grows with the organization
- **Maintainable codebase** allows for long-term evolution
- **Volunteer-friendly UX** reduces training burden

The design favors **clarity, auditability, and reliability** over novelty, ensuring it meets the needs of a real-world community band organization.
