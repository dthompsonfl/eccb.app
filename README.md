# Emerald Coast Community Band Platform

A comprehensive web platform for the Emerald Coast Community Band, built with Next.js 16, React 19, and modern web technologies.

## Overview

This platform provides:

- **Public Website**: A cinematic, dynamic public-facing website with event listings, news, and contact information
- **Member Portal**: Authenticated area for band members to access music library, event calendar, and profile management
- **Admin Dashboard**: Full-featured administration panel for managing members, events, music library, communications, and site content

## Key Features

- 🎵 **Music Library Management**: Upload, organize, and distribute sheet music and audio files
- 📅 **Event Management**: Create events, track RSVPs, and manage attendance
- 👥 **Member Management**: Member profiles, sections, and role assignments
- 📧 **Communications**: Bulk email sending and announcement management
- 🔐 **Role-Based Access Control**: Fine-grained permissions with dot notation
- 📄 **CMS**: Dynamic page creation and content management
- 📊 **Reports**: Attendance and engagement analytics
- 🔎 **Smart Upload OCR**: Optional local `glm-ocr` GPU service for OCR-first music ingestion

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | Next.js 16.1.6 (App Router) |
| Frontend | React 19, TypeScript |
| Styling | Tailwind CSS 4.x, Radix UI |
| Database | MariaDB 14+ (Prisma ORM) |
| Cache/Queue | Redis 6.0+ (BullMQ) |
| Auth | Better Auth |
| Storage | Local filesystem or S3-compatible |
| Optional OCR Service | GLM-OCR via local FastAPI GPU container |
| Testing | Vitest |
| Animation | GSAP ScrollTrigger |

## Quick Start

### Prerequisites

- Node.js 20.x LTS
- MariaDB 14+ (or SQLite for development)
- Redis 6.0+ (optional)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/eccb.app.git
cd eccb.app

# Install dependencies
pnpm install --no-frozen-lockfile

# Interactive environment setup (recommended)
pnpm run setup

# Non-interactive (accept defaults)
# Use in scripts or CI to accept defaults: pnpm run setup -- --yes

# Or manual setup:
# cp .env.example .env && nano .env

# Setup database
pnpm run db:migrate
pnpm run db:seed

# Start development server
pnpm run dev
```

The `pnpm run setup` command opens an interactive, guided wizard that:
- prompts for every environment variable (database, auth, storage, email, etc.) and shows current values / safe defaults,
- auto-generates strong secrets if left blank (AUTH_SECRET, BETTER_AUTH_SECRET),
- conditionally prompts S3/SMTP/ClamAV/VAPID values only when required,
- creates a timestamped backup of any existing `.env` before overwriting it,
- writes the completed `.env` and is safe to re-run (idempotent).

### Setup and Repair System

The platform includes a comprehensive **Setup and Repair System** for database maintenance:

- **Interactive Setup Wizard**: Navigate to `/setup` to configure your database connection and initialize the system
- **Repair Endpoint**: `POST /api/setup/repair` - Repair broken database connections and fix setup issues
- **Status Endpoint**: `GET /api/setup/status` - Check current setup state and health

#### Repair API Actions

| Action | Description |
|--------|-------------|
| `reset` | Reset and reapply database migrations |
| `migrate` | Run database migrations only |
| `seed` | Seed database with initial data |
| `full` | Run complete repair (reset + migrate + seed) |

The `force` parameter (optional, defaults to `false`) can be used to bypass confirmation prompts during repair operations.

 For production builds, `pnpm run build` executes `scripts/setup-admin.sh` during the `prebuild` lifecycle to validate required variables; a masked summary is written to `./build/env-variables-check.txt` and the check is strict for non-CI production builds.

Access the application at http://localhost:3000

For detailed setup instructions, see [LOCAL_SETUP.md](./LOCAL_SETUP.md).

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run dev` | Start development server with hot reload |
| `pnpm run build` | Type-check and build for production |
| `pnpm start` | Start production server |
| `pnpm run lint` | Run ESLint on codebase |
| `pnpm run test` | Run test suite |
| `pnpm run setup` | Interactive environment configuration (`--yes` for non-interactive) |
| `pnpm run db:migrate` | Run database migrations |
| `pnpm run db:seed` | Seed database with initial data |
| `pnpm run db:studio` | Open Prisma Studio GUI |

## Project Structure

```
eccb.app/
├── src/
│   ├── app/                 # Next.js App Router
│   │   ├── (admin)/         # Admin routes (auth + permissions required)
│   │   ├── (auth)/          # Authentication routes
│   │   ├── (member)/        # Member portal (auth required)
│   │   ├── (public)/        # Public routes
│   │   └── api/             # API endpoints
│   ├── components/          # React components
│   │   ├── admin/           # Admin-specific components
│   │   ├── auth/            # Authentication components
│   │   ├── member/          # Member portal components
│   │   ├── public/          # Public website components
│   │   └── ui/              # Shared UI components (shadcn/ui)
│   ├── lib/                 # Utilities and services
│   │   ├── auth/            # Authentication configuration
│   │   ├── jobs/            # Background job definitions
│   │   └── services/        # Business logic services
│   └── workers/             # Background job workers
├── prisma/
│   ├── schema.prisma        # Database schema
│   ├── migrations/          # Migration files
│   └── seed.ts              # Database seed script
├── public/                  # Static assets
├── storage/                 # Local file storage
└── scripts/                 # Utility scripts
```

## Documentation

| Document | Description |
|----------|-------------|
| [LOCAL_SETUP.md](./LOCAL_SETUP.md) | Local development setup guide |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Production deployment guide |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture overview |
| [PERMISSIONS.md](./PERMISSIONS.md) | Permission system documentation |
| [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) | Database schema reference |
| [CHANGELOG.md](./CHANGELOG.md) | Version history and changes |

## Deployment

The platform is designed for self-hosting on Ubuntu 22.04 LTS without Docker.

### Production Requirements

- Ubuntu 22.04 LTS server
- 2GB RAM minimum (4GB recommended)
- 20GB disk space
- Domain name (for SSL)

### Quick Deploy

```bash
# Build for production
pnpm run build

# Start production server
pnpm start
```

For complete deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## GLM-OCR Service

The repository includes an optional local `glm-ocr` service under `services/glm-ocr` for Smart Upload OCR-first workflows.

- Start it with `docker compose up -d glm-ocr`
- Default internal endpoint: `http://glm-ocr:8090/v1`
- Operational guide: [docs/smart-upload-glm-ocr.md](./docs/smart-upload-glm-ocr.md)

## Security Features

- **CSRF Protection**: All state-changing operations protected
- **Rate Limiting**: Configurable limits per endpoint type
- **Secure File Upload**: Type validation, size limits, virus scanning support
- **Permission System**: Fine-grained access control with dot notation
- **Session Security**: Secure session handling with Better Auth
- **Environment Validation**: Required variables validated on startup

## System Settings

### Database-Driven Configuration via Admin UI

All application settings are managed through an intuitive browser-based admin panel at `/admin/settings`:

**Settings are read from:**
1. **Database (`SystemSetting` table)** - Primary source, managed via admin UI
2. **Environment (`.env`)** - Fallback only for first-startup or when database value is missing
3. **Redis cache** - 5-minute TTL for performance

**Key Configuration Areas:**
- **Music Stand**: Real-time sync mode, WebSocket port (3005), polling intervals, feature toggles
- **Email**: SMTP configuration, sender addresses
- **Security**: RBAC policies, password rules, audit settings
- **General**: Band branding, feature flags

**Music Stand Settings:**
- `stand.enabled` - Master kill-switch for the digital music stand
- `stand.realtimeMode` - `"polling"` (default) or `"websocket"`
- `stand.websocketPort` - Port for standalone Socket.IO server (3005)
- `stand.pollingIntervalMs` - Fallback polling interval (5000ms)
- And more: offline mode, practice tracking, audio sync, access policies

**To add new settings:**
1. Add field to `StandGlobalSettings` in `src/lib/stand/settings.ts`
2. Add to `STAND_SETTING_KEYS` allowlist
3. Set default in `DEFAULT_SETTINGS` (fallback to env if needed)
4. Add Zod schema + form field to `music-stand-settings-form.tsx`
5. Auto-persisted to database and cached

## Testing

```bash
# Run all tests
pnpm run test

# Run with coverage
pnpm run test:coverage

# Run specific test
pnpm exec vitest run path/to/test.test.ts
```

## Contributing

1. Create a feature branch: `git checkout -b feat/description`
2. Make changes following the code style in [AGENTS.md](./AGENTS.md)
3. Run tests: `pnpm run test`
4. Run linting: `pnpm run lint`
5. Submit a pull request

## License

Copyright © 2026 Emerald Coast Community Band. All rights reserved.

## Support

For technical issues, contact the development team or create an issue in the repository.

---

**Version**: 0.1.0  
**Status**: Production Ready  
**Last Updated**: February 2026
