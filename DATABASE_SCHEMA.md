# Community Band Management Platform - Database Schema

## Overview

This document provides the complete database schema for the Community Band Management Platform using MariaDB with Prisma ORM. The schema is designed for:

- Data integrity and consistency (ACID compliance)
- Performance (appropriate indexes)
- Auditability (created/updated timestamps, audit logs)
- Scalability (5-10 year lifecycle)
- Multi-tenancy ready (though initially single-org)

**Conventions:**
- All tables have `id` (UUID or auto-increment), `createdAt`, `updatedAt`
- Soft deletes use `deletedAt` (nullable timestamp)
- Foreign keys use `ON DELETE CASCADE` or `SET NULL` as appropriate
- JSON columns for flexible metadata
- Enums for fixed value sets

---

## 1. Core Schema (Prisma)

### 1.1 Users & Authentication

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  emailVerified DateTime?
  name          String?
  image         String?
  
  // Better Auth fields
  password      String?   // Hashed
  
  // Timestamps
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?
  
  // Relations
  accounts      Account[]
  sessions      Session[]
  roles         UserRole[]
  member        Member?   // One-to-one: user may be linked to member profile
  
  // Activity
  auditLogs     AuditLog[]
  notifications UserNotification[]
  
  @@index([email])
  @@index([deletedAt])
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String  // oauth, credentials
  provider          String  // google, github, credentials
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([provider, providerAccountId])
  @@index([userId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  ipAddress    String?
  userAgent    String?
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@index([userId])
  @@index([expires])
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  
  @@unique([identifier, token])
}
```

### 1.2 Roles & Permissions

```prisma
enum RoleType {
  SUPER_ADMIN
  ADMIN
  DIRECTOR
  STAFF
  SECTION_LEADER
  LIBRARIAN
  MUSICIAN
  PUBLIC
}

model Role {
  id          String   @id @default(cuid())
  name        String   @unique // SUPER_ADMIN, ADMIN, etc.
  displayName String   // "Super Administrator"
  description String?
  type        RoleType
  
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  users       UserRole[]
  permissions RolePermission[]
  
  @@index([type])
}

model UserRole {
  id        String   @id @default(cuid())
  userId    String
  roleId    String
  
  assignedAt DateTime @default(now())
  assignedBy String?
  expiresAt  DateTime?
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  role Role @relation(fields: [roleId], references: [id], onDelete: Cascade)
  
  @@unique([userId, roleId])
  @@index([userId])
  @@index([roleId])
}

model Permission {
  id          String   @id @default(cuid())
  name        String   @unique // music.view.all, member.edit, etc.
  resource    String   // music, member, event, cms
  action      String   // view, edit, create, delete
  scope       String?  // all, assigned, own
  description String?
  
  createdAt   DateTime @default(now())
  
  roles       RolePermission[]
  
  @@index([resource, action])
}

model RolePermission {
  id           String @id @default(cuid())
  roleId       String
  permissionId String
  
  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)
  
  @@unique([roleId, permissionId])
  @@index([roleId])
  @@index([permissionId])
}
```

### 1.3 Members & Profiles

```prisma
enum MemberStatus {
  ACTIVE
  INACTIVE
  LEAVE_OF_ABSENCE
  ALUMNI
  AUDITION
  PENDING
}

model Member {
  id              String       @id @default(cuid())
  userId          String?      @unique // Link to User account (optional)
  
  // Personal Info
  firstName       String
  lastName        String
  email           String?
  phone           String?
  profilePhoto    String?
  
  // Band Info
  status          MemberStatus @default(PENDING)
  joinDate        DateTime?
  leaveDate       DateTime?
  
  // Emergency Contact
  emergencyName   String?
  emergencyPhone  String?
  emergencyEmail  String?
  
  // Admin Notes
  notes           String?      @db.Text
  
  // Timestamps
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  deletedAt       DateTime?
  
  // Relations
  user            User?        @relation(fields: [userId], references: [id])
  instruments     MemberInstrument[]
  sections        MemberSection[]
  attendance      Attendance[]
  musicAssignments MusicAssignment[]
  
  @@index([status])
  @@index([lastName, firstName])
  @@index([deletedAt])
}

model Instrument {
  id          String   @id @default(cuid())
  name        String   @unique // Flute, Clarinet, Trumpet, etc.
  family      String   // Woodwind, Brass, Percussion, String
  sortOrder   Int      @default(0)
  
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  members     MemberInstrument[]
  musicParts  MusicPart[]
  
  @@index([family])
  @@index([sortOrder])
}

model MemberInstrument {
  id           String   @id @default(cuid())
  memberId     String
  instrumentId String
  isPrimary    Boolean  @default(false)
  
  member     Member     @relation(fields: [memberId], references: [id], onDelete: Cascade)
  instrument Instrument @relation(fields: [instrumentId], references: [id])
  
  @@unique([memberId, instrumentId])
  @@index([memberId])
  @@index([instrumentId])
}

model Section {
  id          String   @id @default(cuid())
  name        String   @unique // Woodwinds, Brass, Percussion
  description String?
  sortOrder   Int      @default(0)
  
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  members     MemberSection[]
  
  @@index([sortOrder])
}

model MemberSection {
  id        String   @id @default(cuid())
  memberId  String
  sectionId String
  isLeader  Boolean  @default(false)
  
  assignedAt DateTime @default(now())
  
  member  Member  @relation(fields: [memberId], references: [id], onDelete: Cascade)
  section Section @relation(fields: [sectionId], references: [id])
  
  @@unique([memberId, sectionId])
  @@index([memberId])
  @@index([sectionId])
}
```

### 1.4 Music Library (Core)

```prisma
enum MusicDifficulty {
  GRADE_1
  GRADE_2
  GRADE_3
  GRADE_4
  GRADE_5
  GRADE_6
}

model MusicPiece {
  id              String           @id @default(cuid())
  
  // Basic Info
  title           String
  subtitle        String?
  composerId      String?
  arrangerId      String?
  publisherId     String?
  
  // Metadata
  difficulty      MusicDifficulty?
  duration        Int?             // seconds
  genre           String?
  style           String?
  instrumentation String?          @db.Text
  tags            String[]
  
  // Cataloging
  catalogNumber   String?          @unique
  notes           String?          @db.Text
  performanceHistory String?       @db.Text
  
  // Status
  isArchived      Boolean          @default(false)
  
  // Timestamps
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
  deletedAt       DateTime?
  
  // Relations
  composer        Person?          @relation("ComposerPieces", fields: [composerId], references: [id])
  arranger        Person?          @relation("ArrangerPieces", fields: [arrangerId], references: [id])
  publisher       Publisher?       @relation(fields: [publisherId], references: [id])
  files           MusicFile[]
  parts           MusicPart[]
  assignments     MusicAssignment[]
  eventMusic      EventMusic[]
  
  @@index([title])
  @@index([composerId])
  @@index([difficulty])
  @@index([isArchived])
  @@index([deletedAt])
  @@fulltext([title, subtitle, notes])
}

enum FileType {
  FULL_SCORE
  CONDUCTOR_SCORE
  PART
  CONDENSED_SCORE
  AUDIO
  LICENSING
  OTHER
}

model MusicFile {
  id          String   @id @default(cuid())
  pieceId     String
  
  // File Info
  fileName    String
  fileType    FileType
  fileSize    Int      // bytes
  mimeType    String
  storageKey  String   // Local path or S3 key
  storageUrl  String?  // Full URL (if needed)
  
  // Metadata
  version     Int      @default(1)
  description String?
  
  // Access Control
  isPublic    Boolean  @default(false)
  
  // Timestamps
  uploadedAt  DateTime @default(now())
  uploadedBy  String?
  
  // Relations
  piece       MusicPiece @relation(fields: [pieceId], references: [id], onDelete: Cascade)
  parts       MusicPart[]
  downloads   FileDownload[]
  
  @@index([pieceId])
  @@index([fileType])
}

model MusicPart {
  id           String     @id @default(cuid())
  pieceId      String
  instrumentId String
  
  // Part Info
  partName     String     // "Flute 1", "Bb Clarinet 2"
  fileId       String?    // Link to specific MusicFile
  
  // Metadata
  isOptional   Boolean    @default(false)
  notes        String?
  
  piece        MusicPiece @relation(fields: [pieceId], references: [id], onDelete: Cascade)
  instrument   Instrument @relation(fields: [instrumentId], references: [id])
  file         MusicFile? @relation(fields: [fileId], references: [id])
  
  @@index([pieceId])
  @@index([instrumentId])
}

model Person {
  id              String       @id @default(cuid())
  firstName       String
  lastName        String
  fullName        String       // Computed: "LastName, FirstName"
  bio             String?      @db.Text
  
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  
  // Relations
  composedPieces  MusicPiece[] @relation("ComposerPieces")
  arrangedPieces  MusicPiece[] @relation("ArrangerPieces")
  
  @@index([lastName, firstName])
}

model Publisher {
  id          String       @id @default(cuid())
  name        String       @unique
  website     String?
  contactInfo String?
  
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  
  // Relations
  pieces      MusicPiece[]
  
  @@index([name])
}

model MusicAssignment {
  id          String     @id @default(cuid())
  pieceId     String
  memberId    String
  
  // Assignment Info
  partName    String?    // Specific part assigned
  priority    Int?       // For ordering multiple assignments
  notes       String?
  
  assignedAt  DateTime   @default(now())
  assignedBy  String?
  dueDate     DateTime?
  
  piece       MusicPiece @relation(fields: [pieceId], references: [id], onDelete: Cascade)
  member      Member     @relation(fields: [memberId], references: [id], onDelete: Cascade)
  
  @@index([pieceId])
  @@index([memberId])
  @@index([dueDate])
}

model FileDownload {
  id          String     @id @default(cuid())
  fileId      String
  userId      String?
  
  // Download Info
  downloadedAt DateTime  @default(now())
  ipAddress    String?
  userAgent    String?
  
  file        MusicFile  @relation(fields: [fileId], references: [id], onDelete: Cascade)
  
  @@index([fileId])
  @@index([userId])
  @@index([downloadedAt])
}
```

### 1.5 Events & Rehearsals

```prisma
enum EventType {
  CONCERT
  REHEARSAL
  SECTIONAL
  BOARD_MEETING
  SOCIAL
  OTHER
}

enum AttendanceStatus {
  PRESENT
  ABSENT
  EXCUSED
  LATE
  LEFT_EARLY
}

model Event {
  id              String       @id @default(cuid())
  
  // Basic Info
  title           String
  description     String?      @db.Text
  type            EventType
  
  // Schedule
  startTime       DateTime
  endTime         DateTime
  location        String?
  venueId         String?
  
  // Call Times
  callTime        DateTime?
  dressCode       String?
  
  // Concert-Specific
  programOrder    Json?        // Array of piece IDs with notes
  
  // Status
  isCancelled     Boolean      @default(false)
  isPublished     Boolean      @default(false)
  
  // Timestamps
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  deletedAt       DateTime?
  
  // Relations
  venue           Venue?       @relation(fields: [venueId], references: [id])
  attendance      Attendance[]
  music           EventMusic[]
  notes           EventNote[]
  
  @@index([type])
  @@index([startTime])
  @@index([isPublished])
  @@index([deletedAt])
}

model Venue {
  id          String   @id @default(cuid())
  name        String
  address     String?
  city        String?
  state       String?
  zipCode     String?
  
  directions  String?  @db.Text
  parking     String?  @db.Text
  
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  events      Event[]
  
  @@index([name])
}

model Attendance {
  id          String           @id @default(cuid())
  eventId     String
  memberId    String
  
  status      AttendanceStatus
  notes       String?
  
  markedAt    DateTime         @default(now())
  markedBy    String?
  
  event       Event            @relation(fields: [eventId], references: [id], onDelete: Cascade)
  member      Member           @relation(fields: [memberId], references: [id], onDelete: Cascade)
  
  @@unique([eventId, memberId])
  @@index([eventId])
  @@index([memberId])
  @@index([status])
}

model EventMusic {
  id          String     @id @default(cuid())
  eventId     String
  pieceId     String
  
  sortOrder   Int        @default(0)
  notes       String?
  
  event       Event      @relation(fields: [eventId], references: [id], onDelete: Cascade)
  piece       MusicPiece @relation(fields: [pieceId], references: [id], onDelete: Cascade)
  
  @@unique([eventId, pieceId])
  @@index([eventId])
  @@index([pieceId])
}

model EventNote {
  id          String   @id @default(cuid())
  eventId     String
  
  title       String?
  content     String   @db.Text
  
  // Visibility
  isPublic    Boolean  @default(false)
  targetSection String? // If section-specific
  
  createdAt   DateTime @default(now())
  createdBy   String?
  updatedAt   DateTime @updatedAt
  
  event       Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)
  
  @@index([eventId])
}
```

### 1.6 CMS & Content

```prisma
enum ContentStatus {
  DRAFT
  SCHEDULED
  PUBLISHED
  ARCHIVED
}

model Page {
  id          String        @id @default(cuid())
  
  // Meta
  title       String
  slug        String        @unique
  description String?
  
  // Content
  content     Json          // Structured content (sections, blocks)
  rawMarkdown String?       @db.Text
  
  // SEO
  metaTitle   String?
  metaDescription String?
  metaKeywords String[]
  ogImage     String?
  
  // Publishing
  status      ContentStatus @default(DRAFT)
  publishedAt DateTime?
  scheduledFor DateTime?
  
  // Versioning
  version     Int           @default(1)
  parentVersionId String?
  
  // Timestamps
  createdAt   DateTime      @default(now())
  createdBy   String?
  updatedAt   DateTime      @updatedAt
  updatedBy   String?
  deletedAt   DateTime?
  
  // Relations
  versions    PageVersion[]
  
  @@index([slug])
  @@index([status])
  @@index([publishedAt])
  @@fulltext([title, description, rawMarkdown])
}

model PageVersion {
  id          String   @id @default(cuid())
  pageId      String
  
  version     Int
  content     Json
  
  createdAt   DateTime @default(now())
  createdBy   String?
  
  page        Page     @relation(fields: [pageId], references: [id], onDelete: Cascade)
  
  @@unique([pageId, version])
  @@index([pageId])
}

model Announcement {
  id          String        @id @default(cuid())
  
  title       String
  content     String        @db.Text
  
  // Targeting
  targetRoles String[]      // Empty = all users
  isUrgent    Boolean       @default(false)
  
  // Publishing
  status      ContentStatus @default(DRAFT)
  publishedAt DateTime?
  expiresAt   DateTime?
  
  createdAt   DateTime      @default(now())
  createdBy   String?
  updatedAt   DateTime      @updatedAt
  
  // Relations
  notifications UserNotification[]
  
  @@index([status])
  @@index([publishedAt])
  @@index([expiresAt])
}

model MediaAsset {
  id          String   @id @default(cuid())
  
  // File Info
  fileName    String
  fileSize    Int
  mimeType    String
  storageKey  String   // Local path or S3 key
  storageUrl  String?
  
  // Metadata
  title       String?
  altText     String?
  caption     String?
  tags        String[]
  
  // Dimensions (for images)
  width       Int?
  height      Int?
  
  uploadedAt  DateTime @default(now())
  uploadedBy  String?
  
  @@index([mimeType])
  @@index([uploadedAt])
}
```

### 1.7 Communications

```prisma
enum NotificationType {
  ANNOUNCEMENT
  EVENT_REMINDER
  MUSIC_ASSIGNMENT
  ATTENDANCE_REMINDER
  SYSTEM
}

model UserNotification {
  id             String           @id @default(cuid())
  userId         String
  
  type           NotificationType
  title          String
  message        String           @db.Text
  
  // Links
  linkUrl        String?
  linkText       String?
  
  // Reference
  announcementId String?
  eventId        String?
  
  // Status
  isRead         Boolean          @default(false)
  readAt         DateTime?
  
  createdAt      DateTime         @default(now())
  
  user           User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  announcement   Announcement?    @relation(fields: [announcementId], references: [id])
  
  @@index([userId])
  @@index([isRead])
  @@index([createdAt])
}

model Message {
  id          String   @id @default(cuid())
  
  subject     String
  body        String   @db.Text
  
  // Sender
  senderId    String
  senderName  String
  
  // Recipients (JSON array of user IDs or "all", "section:xyz")
  recipients  Json
  
  // Status
  sentAt      DateTime @default(now())
  
  @@index([senderId])
  @@index([sentAt])
}
```

### 1.8 Configuration & System

```prisma
model SystemSetting {
  id          String   @id @default(cuid())
  key         String   @unique
  value       String   @db.Text
  description String?
  
  updatedAt   DateTime @updatedAt
  updatedBy   String?
  
  @@index([key])
}

model AuditLog {
  id          String   @id @default(cuid())
  
  // Actor
  userId      String?
  userName    String?
  ipAddress   String?
  userAgent   String?
  
  // Action
  action      String   // CREATE, UPDATE, DELETE, LOGIN, etc.
  entityType  String   // User, Member, MusicPiece, etc.
  entityId    String?
  
  // Changes
  oldValues   Json?
  newValues   Json?
  
  timestamp   DateTime @default(now())
  
  user        User?    @relation(fields: [userId], references: [id])
  
  @@index([userId])
  @@index([entityType, entityId])
  @@index([timestamp])
  @@index([action])
}
```

---

## 2. Database Indexes

### 2.1 Performance Indexes

**Frequently Queried Columns:**
```sql
CREATE INDEX idx_members_status ON members(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_events_start_time ON events(start_time) WHERE is_cancelled = false;
CREATE INDEX idx_music_pieces_title_trgm ON music_pieces USING gin(title gin_trgm_ops);
```

**Full-Text Search:**
```sql
CREATE INDEX idx_music_pieces_fulltext ON music_pieces USING gin(to_tsvector('english', title || ' ' || COALESCE(subtitle, '') || ' ' || COALESCE(notes, '')));
CREATE INDEX idx_pages_fulltext ON pages USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '') || ' ' || COALESCE(raw_markdown, '')));
```

### 2.2 Composite Indexes

```sql
CREATE INDEX idx_attendance_event_member ON attendance(event_id, member_id);
CREATE INDEX idx_user_roles_user_role ON user_roles(user_id, role_id);
CREATE INDEX idx_file_downloads_file_user ON file_downloads(file_id, user_id);
```

---

## 3. Data Integrity Rules

### 3.1 Foreign Key Constraints

- `ON DELETE CASCADE`: Child records deleted when parent is deleted
  - User → Sessions, Accounts
  - Event → Attendance, EventMusic
  - MusicPiece → MusicFiles, MusicParts

- `ON DELETE SET NULL`: Reference cleared when parent is deleted
  - Member → User (member profile persists if user account deleted)

### 3.2 Check Constraints

```sql
ALTER TABLE events ADD CONSTRAINT check_event_times CHECK (end_time > start_time);
ALTER TABLE music_files ADD CONSTRAINT check_file_size CHECK (file_size > 0);
ALTER TABLE attendance ADD CONSTRAINT check_attendance_dates CHECK (marked_at <= NOW());
```

### 3.3 Unique Constraints

- `users.email` - No duplicate email addresses
- `music_pieces.catalog_number` - Unique catalog identifiers
- `pages.slug` - Unique URL slugs
- `[event_id, member_id]` - One attendance record per member per event

---

## 4. Data Migration Strategy

### 4.1 Initial Schema Creation

```bash
# Initialize Prisma
npx prisma init

# Create migration
npx prisma migrate dev --name init

# Generate Prisma Client
npx prisma generate
```

### 4.2 Seed Data

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create default roles
  const roles = await Promise.all([
    prisma.role.create({
      data: {
        name: 'SUPER_ADMIN',
        displayName: 'Super Administrator',
        type: 'SUPER_ADMIN',
      },
    }),
    prisma.role.create({
      data: {
        name: 'MUSICIAN',
        displayName: 'Musician',
        type: 'MUSICIAN',
      },
    }),
  ]);
  
  // Create default instruments
  const instruments = await Promise.all([
    prisma.instrument.create({
      data: { name: 'Flute', family: 'Woodwind', sortOrder: 1 },
    }),
    prisma.instrument.create({
      data: { name: 'Clarinet', family: 'Woodwind', sortOrder: 2 },
    }),
    prisma.instrument.create({
      data: { name: 'Trumpet', family: 'Brass', sortOrder: 10 },
    }),
  ]);
  
  // Create default permissions
  const permissions = [
    { name: 'music.view.all', resource: 'music', action: 'view', scope: 'all' },
    { name: 'music.edit', resource: 'music', action: 'edit', scope: null },
    { name: 'member.view.all', resource: 'member', action: 'view', scope: 'all' },
    { name: 'cms.edit', resource: 'cms', action: 'edit', scope: null },
  ];
  
  for (const perm of permissions) {
    await prisma.permission.create({ data: perm });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

### 4.3 Production Migrations

```bash
# Review migration SQL before applying
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel --script

# Apply to production (with backup first!)
npx prisma migrate deploy
```

---

## 5. Database Backup & Restore

### 5.1 Backup Strategy

**Daily Automated Backups:**
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME -F c -b -v -f "backup_${DATE}.dump"
aws s3 cp "backup_${DATE}.dump" s3://eccb-backups/database/
```

**Point-in-Time Recovery:**
- Enable WAL archiving
- Retention: 7 days (adjustable)

### 5.2 Restore Procedure

```bash
# Restore from dump
pg_restore -h $DB_HOST -U $DB_USER -d $DB_NAME -v "backup_20260128.dump"

# Verify data integrity
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "SELECT COUNT(*) FROM users;"
```

---

## 6. Performance Optimization

### 6.1 Query Optimization

**Use Prisma's `select` to reduce data transfer:**
```typescript
const members = await prisma.member.findMany({
  select: {
    id: true,
    firstName: true,
    lastName: true,
  },
});
```

**Use `include` carefully (avoid N+1):**
```typescript
const events = await prisma.event.findMany({
  include: {
    attendance: {
      include: {
        member: true,
      },
    },
  },
});
```

### 6.2 Connection Pooling

```env
DATABASE_URL="MariaDB://user:pass@host:5432/db?connection_limit=20&pool_timeout=10"
```

### 6.3 Read Replicas (Future)

```typescript
// prisma/client.ts
export const prismaRead = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_READ_URL,
    },
  },
});

export const prismaWrite = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_WRITE_URL,
    },
  },
});
```

---

## 7. Data Privacy & Compliance

### 7.1 PII Handling

**Encrypted Fields:**
- Emergency contact info
- Phone numbers
- Email addresses (hashed for lookups)

**Right to be Forgotten (GDPR):**

> **NOT IMPLEMENTED.** No `anonymizeMember` function exists in `src/` today. The snippet below is a *design sketch only* and must not be cited as a delivered feature. Erasure is a much larger problem than nulling a handful of `Member` columns: the schema has 47 `onDelete: Cascade` relations, so deleting a `User` would silently destroy child rows, while `Annotation.userId` is a **required** FK with no `onDelete`, meaning a naive hard delete is rejected by the database. A real implementation must decide per-model whether to delete, anonymise, or retain, and must run transactionally and idempotently. See `src/lib/privacy/` and the privacy tests for the implemented behaviour, and TODO.md for what remains.

Illustrative shape only — not shipped code:
```typescript
async function anonymizeMember(memberId: string) { /* see src/lib/privacy/erasure.ts */ }
```

### 7.2 Data Retention

> **POLICY ONLY — NOT ENFORCED IN CODE.** No background job prunes sessions, audit logs, or file-download records against these windows. The values below describe intent; nothing currently deletes data on this schedule. Treat them as a requirement to build, not a guarantee.

- **Active Members**: Indefinite
- **Alumni**: 10 years after departure (not enforced)
- **Audit Logs**: 7 years (not enforced)
- **File Downloads**: 1 year (not enforced)
- **Sessions**: 30 days (not enforced)

---

## 8. Monitoring & Maintenance

### 8.1 Health Checks

```sql
-- Check for orphaned records
SELECT COUNT(*) FROM members WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users);

-- Check for missing indexes
SELECT schemaname, tablename, indexname FROM pg_indexes WHERE tablename IN ('members', 'music_pieces', 'events');

-- Check table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### 8.2 Routine Maintenance

```sql
-- Vacuum and analyze
VACUUM ANALYZE;

-- Reindex
REINDEX DATABASE eccb;

-- Update statistics
ANALYZE;
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

```typescript
// lib/db/__tests__/member.test.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Member Database Operations', () => {
  beforeAll(async () => {
    // Setup test database
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should create a new member', async () => {
    const member = await prisma.member.create({
      data: {
        firstName: 'John',
        lastName: 'Doe',
        status: 'ACTIVE',
      },
    });

    expect(member.firstName).toBe('John');
    expect(member.status).toBe('ACTIVE');
  });
});
```

### 9.2 Integration Tests

Test complex queries and transactions:
```typescript
it('should assign music to event and track attendance', async () => {
  const event = await prisma.event.create({
    data: {
      title: 'Spring Concert',
      type: 'CONCERT',
      startTime: new Date('2026-05-01T19:00:00Z'),
      endTime: new Date('2026-05-01T21:00:00Z'),
    },
  });

  const piece = await prisma.musicPiece.create({
    data: {
      title: 'Test Piece',
    },
  });

  await prisma.eventMusic.create({
    data: {
      eventId: event.id,
      pieceId: piece.id,
    },
  });

  const result = await prisma.event.findUnique({
    where: { id: event.id },
    include: { music: true },
  });

  expect(result?.music).toHaveLength(1);
});
```

---

## 10. Smart Upload Session Model (OCR-First Pipeline)

### 10.1 SmartUploadSession

The `SmartUploadSession` model tracks PDF uploads and their AI-powered metadata extraction. This model supports the OCR-first pipeline with provenance tracking.

```prisma
model SmartUploadSession {
  id                 String           @id @default(cuid())
  uploadSessionId    String           @unique
  fileName           String
  fileSize           Int
  mimeType           String
  storageKey         String
  extractedMetadata  Json?
  confidenceScore    Int?
  status             SmartUploadStatus @default(PENDING_REVIEW)
  uploadedBy         String
  reviewedBy         String?
  reviewedAt         DateTime?
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  parsedParts        Json?
  parseStatus        String?
  secondPassStatus   String?
  secondPassResult   Json?
  autoApproved       Boolean          @default(false)
  routingDecision    String?
  cuttingInstructions Json?
  llmProvider        String?
  llmVisionModel     String?
  llmVerifyModel     String?
  llmModelParams     Json?
  llmPromptVersion   String?
  tempFiles          Json?
  firstPassRaw       String?          @db.LongText
  secondPassRaw      String?          @db.LongText
  adjudicatorStatus  String?
  adjudicatorResult  Json?
  adjudicatorRaw     String?          @db.LongText
  finalConfidence    Int?
  requiresHumanReview Boolean          @default(false)
  llmAdjudicatorModel String?
  /// SHA-256 of the original uploaded PDF bytes (hex). Used for fast exact-duplicate detection.
  sourceSha256       String?          @db.Char(64)
  /// JSON array of strategy attempts: [{strategy, confidence, failureReasons, durationMs, timestamp}]
  strategyHistory    Json?
  /// Total LLM calls consumed by this session (persisted so retries don't reset the budget).
  llmCallCount       Int              @default(0)
  /// OCR engine used: tesseract, ocrmypdf, vision_api, native
  ocrEngineUsed     String?
  /// OCR mode used: header, full, both
  ocrModeUsed       String?
  /// Raw OCR text extracted from PDF (for debugging/provenance). Only stored if smart_upload_store_raw_ocr_text is enabled.
  rawOcrText        String?           @db.LongText
  /// Character count of raw OCR text (for quick validation)
  ocrTextChars      Int?

  @@index([uploadSessionId])
  @@index([status])
  @@index([uploadedBy])
  @@index([sourceSha256])
  @@index([ocrEngineUsed])
  @@index([ocrModeUsed])
}

enum SmartUploadStatus {
  PENDING_REVIEW
  PROCESSING
  APPROVED
  REJECTED
  NEEDS_REVISION
}
```

### 10.2 OCR Provenance Fields

The following fields were added to support the OCR-first pipeline (migration: `20260303000000_smart_upload_ocr_provenance`):

| Field | Type | Description |
|-------|------|-------------|
| `ocrEngineUsed` | String? | OCR engine used: `tesseract`, `ocrmypdf`, `vision_api`, `native` |
| `ocrModeUsed` | String? | OCR mode used: `header`, `full`, `both` |
| `rawOcrText` | String? (LongText) | Raw OCR text extracted from PDF (for debugging/provenance). Only stored if `smart_upload_store_raw_ocr_text` setting is enabled. |
| `ocrTextChars` | Int? | Character count of raw OCR text (for quick validation) |

Indexes are created on `ocrEngineUsed` and `ocrModeUsed` for efficient querying.

---

## 11. Conclusion

This database schema provides a robust foundation for the Community Band Management Platform with:

- **Complete domain coverage**: All 17 feature areas represented
- **Data integrity**: Foreign keys, constraints, and validation
- **Performance**: Strategic indexes and query optimization
- **Auditability**: Comprehensive logging and versioning
- **Scalability**: Designed for 5-10 year lifecycle
- **Security**: Soft deletes, encryption, and access control

The schema is production-ready and can be extended as new requirements emerge without breaking existing functionality.
