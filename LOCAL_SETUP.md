# Local Development Setup - Ubuntu 22.04 LTS

This guide covers setting up the Emerald Coast Community Band platform for local development on Ubuntu 22.04 LTS.

## Prerequisites

### System Requirements

- Ubuntu 22.04 LTS
- 2GB RAM minimum (4GB recommended)
- 10GB free disk space
- sudo access

### Required Software

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 20.x LTS | JavaScript runtime |
| MariaDB | 14+ | Primary database |
| Redis | 6.0+ | Caching and job queues |
| Git | 2.34+ | Version control |

## System Dependencies

Install build tools and dependencies:

```bash
# Update package lists
sudo apt update

# Install build essentials
sudo apt install -y build-essential curl git

# Install Python (for node-gyp)
sudo apt install -y python3 python3-pip
```

## Node.js Installation

Install Node.js 20.x LTS via NodeSource:

```bash
# Add NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# Install Node.js
sudo apt install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version   # Should show 10.x.x
```

## MariaDB Setup

### Installation

```bash
# Install MariaDB 14
sudo apt install -y MariaDB MariaDB-contrib

# Start and enable service
sudo systemctl start MariaDB
sudo systemctl enable MariaDB

# Verify status
sudo systemctl status MariaDB
```

### Database Configuration

```bash
# Switch to MariaDB user
sudo -u MariaDB psql

# Create database and user
CREATE DATABASE eccb_platform;
CREATE USER eccb_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE eccb_platform TO eccb_user;

# Connect to database and grant schema permissions
\c eccb_platform
GRANT ALL ON SCHEMA public TO eccb_user;

# Exit psql
\q
```

### Configure Authentication

Edit MariaDB configuration to allow password authentication:

```bash
# Edit pg_hba.conf
sudo nano /etc/MariaDB/14/main/pg_hba.conf
```

Change the line for local connections from `peer` to `md5`:

```
# Before:
local   all             all                                     peer

# After:
local   all             all                                     md5
```

Restart MariaDB:

```bash
sudo systemctl restart MariaDB
```

### Test Connection

```bash
# Test connection with new user
psql -h localhost -U eccb_user -d eccb_platform
# Enter password when prompted
```

## Redis Setup

### Installation

```bash
# Install Redis
sudo apt install -y redis-server

# Start and enable service
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Verify status
sudo systemctl status redis-server
```

### Test Connection

```bash
# Test Redis connection
redis-cli ping
# Should return: PONG
```

## Application Setup

### Clone Repository

```bash
# Clone the repository
git clone https://github.com/your-org/eccb.app.git
cd eccb.app
```

### Install Dependencies

```bash
# Install Node.js dependencies
pnpm install --no-frozen-lockfile
```

### Environment Configuration

The easiest way to configure your environment is to use the interactive setup script (recommended):

```bash
# Interactive setup (guided through all variables)
pnpm run setup

# Non-interactive (accept defaults) — useful for CI or automation
pnpm run setup -- --yes
```

Interactive setup features:
- Prompts for all required and optional variables and shows current values / safe defaults
- Auto-generates secure secrets when left blank (AUTH_SECRET, BETTER_AUTH_SECRET)
- Conditionally prompts S3 / SMTP / ClamAV / VAPID variables only when needed
- Backs up an existing `.env` to `.env.backup.<timestamp>` before writing
- Validates key lengths (secrets ≥32 chars, SUPER_ADMIN_PASSWORD ≥8 chars)
- Idempotent — safe to re-run and preserves existing values

If you prefer manual setup, continue with the steps below:

Alternatively, for manual setup:

```bash
# Copy example environment file
cp .env.example .env

# Edit environment variables
nano .env
```

Configure the following required variables:

```env
# Database - use the password you set earlier
DATABASE_URL="MariaDB://eccb_user:your_secure_password@localhost:5432/eccb_platform"

# Redis
REDIS_URL="redis://localhost:6379"

# Auth secrets - generate with: openssl rand -base64 32
AUTH_SECRET="your-generated-secret-here"
BETTER_AUTH_SECRET="your-generated-secret-here"

# Application URL
AUTH_URL="http://localhost:3000"
BETTER_AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# Storage (local filesystem)
STORAGE_DRIVER="LOCAL"
LOCAL_STORAGE_PATH="./storage"

# Email (log to console for development)
EMAIL_DRIVER="LOG"

# Super Admin Credentials (REQUIRED before seeding)
SUPER_ADMIN_EMAIL="admin@eccb.org"
SUPER_ADMIN_PASSWORD="your-secure-admin-password"
```

Generate auth secrets:

```bash
# Generate two secrets
openssl rand -base64 32
openssl rand -base64 32
```

### Database Migrations

```bash
# Run Prisma migrations
pnpm run db:migrate

# Generate Prisma client
pnpm exec prisma generate
```

### Seed Database

> Security: the seed process requires explicit SUPER_ADMIN credentials. Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in your `.env` before running `db:seed` — the script will fail if the password is missing.

```bash
# Ensure SUPER_ADMIN_PASSWORD is set in .env, then seed with initial data (admin user, roles, permissions)
pnpm run db:seed
```

> Note: `pnpm run build` now runs `scripts/setup-admin.sh` during the `prebuild` lifecycle to validate/capture required environment variables before building. The script writes a masked summary to `./build/env-variables-check.txt`.

### Create Storage Directory

```bash
# Create local storage directory
mkdir -p storage

# Set permissions (if needed)
chmod 755 storage
```

## Running the Application

### Development Mode

```bash
# Start development server with hot reload
pnpm run dev
```

Access the application at: http://localhost:3000

### Production Build

```bash
# Build for production
pnpm run build

# Start production server
pnpm start
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run dev` | Start development server with hot reload |
| `pnpm run build` | Type-check and build for production |
| `pnpm start` | Start production server (requires build first) |
| `pnpm run lint` | Run ESLint on codebase |
| `pnpm run test` | Run test suite with Vitest |
| `pnpm run db:migrate` | Run database migrations |
| `pnpm run db:seed` | Seed database with initial data |
| `pnpm run db:studio` | Open Prisma Studio GUI |

## Default Login Credentials

After seeding, the seeder ensures a `SUPER_ADMIN` account exists. Behavior is idempotent: if a user with `SUPER_ADMIN_EMAIL` already exists the seeder will assign the `SUPER_ADMIN` role to that user; otherwise the seeder will create the admin user.

- **Email:** `admin@eccb.org` (or value of `SUPER_ADMIN_EMAIL`)
- **Password:** Value of `SUPER_ADMIN_PASSWORD` in `.env`

**Important:** You must set `SUPER_ADMIN_PASSWORD` before running `pnpm run db:seed` — the seeder will refuse to run without it. Change the password immediately after first login and never commit credentials to version control.

## Troubleshooting

### Database Connection Issues

```bash
# Check MariaDB status
sudo systemctl status MariaDB

# Test connection
psql -h localhost -U eccb_user -d eccb_platform

# Check logs
sudo tail -f /var/log/MariaDB/MariaDB-14-main.log
```

### Redis Connection Issues

```bash
# Check Redis status
sudo systemctl status redis-server

# Test connection
redis-cli ping

# Check logs
sudo tail -f /var/log/redis/redis-server.log
```

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>
```

### Prisma Issues

```bash
# Regenerate Prisma client
pnpm exec prisma generate

# Reset database (WARNING: destroys all data)
pnpm exec prisma migrate reset

# View database in GUI
pnpm exec prisma studio
```

### Build Errors

```bash
# Clear Next.js cache
rm -rf .next

# Reinstall dependencies
rm -rf node_modules
pnpm install --no-frozen-lockfile

# Rebuild
pnpm run build
```

## Health Check

Verify all services are running:

```bash
# Check application health endpoint
curl http://localhost:3000/api/health

# Expected response:
# {"status":"ok","database":"connected","redis":"connected"}
```

## Log Locations

| Service | Log Path |
|---------|----------|
| Application | Console output / `logs/` directory |
| MariaDB | `/var/log/MariaDB/MariaDB-14-main.log` |
| Redis | `/var/log/redis/redis-server.log` |

## Development Tips

### Database Management

```bash
# Open Prisma Studio (GUI for database)
pnpm run db:studio

# Create a new migration after schema changes
pnpm exec prisma migrate dev --name description_of_change
```

### Testing

```bash
# Run all tests
pnpm run test

# Run tests with coverage
pnpm run test:coverage

# Run specific test file
pnpm exec vitest run path/to/test.test.ts
```

### Code Quality

```bash
# Run linter
pnpm run lint

# Fix auto-fixable issues
pnpm run lint -- --fix
```

## Architecture Overview

```
eccb.app/
├── src/
│   ├── app/                 # Next.js App Router
│   │   ├── (admin)/         # Admin routes (requires auth + permissions)
│   │   ├── (auth)/          # Authentication routes
│   │   ├── (member)/        # Member portal routes (requires auth)
│   │   ├── (public)/        # Public routes
│   │   └── api/             # API routes
│   ├── components/          # React components
│   ├── lib/                 # Utilities and services
│   └── workers/             # Background job workers
├── prisma/
│   ├── schema.prisma        # Database schema
│   ├── migrations/          # Migration files
│   └── seed.ts              # Database seed script
├── public/                  # Static assets
├── storage/                 # Local file storage
└── scripts/                 # Utility scripts
```

## Next Steps

1. Review [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment
2. Review [ARCHITECTURE.md](./ARCHITECTURE.md) for system architecture
3. Review [PERMISSIONS.md](./PERMISSIONS.md) for permission system details

---

**Last Updated:** February 2026
**Status:** Production-ready for Ubuntu 22.04 LTS local hosting
