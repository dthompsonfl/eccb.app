import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { auth } from '@/lib/auth/config';
import { getDefaultEndpointForProvider } from '@/lib/llm/providers';
import type { LLMProviderValue } from '@/lib/llm/providers';
import {
  ALL_PERMISSIONS,
  MUSIC_VIEW_ALL,
  MUSIC_CREATE,
  MUSIC_EDIT,
  MUSIC_DELETE,
  MUSIC_UPLOAD,
  MUSIC_DOWNLOAD_ALL,
  MUSIC_VIEW_ASSIGNED,
  MUSIC_DOWNLOAD_ASSIGNED,
  MEMBER_VIEW_OWN,
  MEMBER_EDIT_OWN,
  EVENT_VIEW_ALL,
  ATTENDANCE_MARK_OWN,
} from '@/lib/auth/permission-constants';
import { assertSuperAdminPasswordPresentForSeed } from '@/lib/seeding';
import { seedStandE2EFixture } from './seed-stand-fixture';

// If DATABASE_URL points to MySQL/MariaDB, provide a driver adapter required by the "client" (WASM) engine.
function _parseDbUrl(url?: string) {
  if (!url) return null;
  const regex = /^mysql:\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?\/(.+)$/;
  const match = url.match(regex);
  if (!match) return null;
  return {
    user: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    host: match[3],
    port: match[4] ? Number(match[4]) : 3306,
    database: match[5],
  };
}

const _cfg = _parseDbUrl(process.env.DATABASE_URL);
const _adapter = _cfg ? new (await import('@prisma/adapter-mariadb')).PrismaMariaDb({ host: _cfg.host, user: _cfg.user, password: _cfg.password, database: _cfg.database }) : undefined;

const prisma = new PrismaClient({
  ...( _adapter ? { adapter: _adapter } : {} ),
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Roles
  const roles = await Promise.all([
    prisma.role.upsert({
      where: { name: 'SUPER_ADMIN' },
      update: {},
      create: { name: 'SUPER_ADMIN', displayName: 'Super Administrator', type: 'SUPER_ADMIN', description: 'Full system access' },
    }),
    prisma.role.upsert({
      where: { name: 'ADMIN' },
      update: {},
      create: { name: 'ADMIN', displayName: 'Administrator', type: 'ADMIN', description: 'Band operations management' },
    }),
    prisma.role.upsert({
      where: { name: 'DIRECTOR' },
      update: {},
      create: { name: 'DIRECTOR', displayName: 'Director/Staff', type: 'DIRECTOR', description: 'Musical and operational leadership' },
    }),
    prisma.role.upsert({
      where: { name: 'LIBRARIAN' },
      update: {},
      create: { name: 'LIBRARIAN', displayName: 'Librarian', type: 'LIBRARIAN', description: 'Music library management' },
    }),
    prisma.role.upsert({
      where: { name: 'SECTION_LEADER' },
      update: {},
      create: { name: 'SECTION_LEADER', displayName: 'Section Leader', type: 'SECTION_LEADER', description: 'Musical leadership for a section' },
    }),
    prisma.role.upsert({
      where: { name: 'MUSICIAN' },
      update: {},
      create: { name: 'MUSICIAN', displayName: 'Musician', type: 'MUSICIAN', description: 'Band member' },
    }),
    prisma.role.upsert({
      where: { name: 'PUBLIC' },
      update: {},
      create: { name: 'PUBLIC', displayName: 'Public User', type: 'PUBLIC', description: 'Limited access for public users' },
    }),
  ]);

  console.log(`✅ Created ${roles.length} roles`);

  // 2. Permissions
  const permissionsData = ALL_PERMISSIONS.map((name) => {
    const parts = name.split('.');
    return { 
      name, 
      resource: parts[0], 
      action: parts[1], 
      scope: parts[2] || null 
    };
  });

  // Execute sequentially to avoid connection pool exhaustion
  for (const perm of permissionsData) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }

  console.log(`✅ Created ${permissionsData.length} permissions`);

  // 3. Assign permissions to roles
  const superAdminRole = roles.find((r) => r.name === 'SUPER_ADMIN');
  const librarianRole = roles.find((r) => r.name === 'LIBRARIAN');
  const musicianRole = roles.find((r) => r.name === 'MUSICIAN');

  if (!superAdminRole || !librarianRole || !musicianRole) {
    throw new Error('❌ Required roles failed to generate during seeding.');
  }

  // Super admin gets everything
  const allPermissions = await prisma.permission.findMany();
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: superAdminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: superAdminRole.id, permissionId: perm.id },
    });
  }

  // Librarian music permissions
  const librarianPermNames = [MUSIC_VIEW_ALL, MUSIC_CREATE, MUSIC_EDIT, MUSIC_DELETE, MUSIC_UPLOAD, MUSIC_DOWNLOAD_ALL];
  for (const permName of librarianPermNames) {
    const perm = allPermissions.find((p) => p.name === permName);
    if (perm) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: librarianRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: librarianRole.id, permissionId: perm.id },
      });
    }
  }

  // Musician permissions
  const musicianPermNames = [MUSIC_VIEW_ASSIGNED, MUSIC_DOWNLOAD_ASSIGNED, MEMBER_VIEW_OWN, MEMBER_EDIT_OWN, EVENT_VIEW_ALL, ATTENDANCE_MARK_OWN];
  for (const permName of musicianPermNames) {
    const perm = allPermissions.find((p) => p.name === permName);
    if (perm) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: musicianRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: musicianRole.id, permissionId: perm.id },
      });
    }
  }

  console.log('✅ Assigned permissions to roles');

  // 4. Instruments
  const instruments = [
    { name: 'Piccolo', family: 'Woodwind', sortOrder: 1 },
    { name: 'Flute', family: 'Woodwind', sortOrder: 2 },
    { name: 'Oboe', family: 'Woodwind', sortOrder: 3 },
    { name: 'English Horn', family: 'Woodwind', sortOrder: 4 },
    { name: 'Bassoon', family: 'Woodwind', sortOrder: 5 },
    { name: 'Contrabassoon', family: 'Woodwind', sortOrder: 6 },
    { name: 'E♭ Clarinet', family: 'Woodwind', sortOrder: 7 },
    { name: 'B♭ Clarinet', family: 'Woodwind', sortOrder: 8 },
    { name: 'Alto Clarinet', family: 'Woodwind', sortOrder: 9 },
    { name: 'Bass Clarinet', family: 'Woodwind', sortOrder: 10 },
    { name: 'Contra-alto Clarinet', family: 'Woodwind', sortOrder: 11 },
    { name: 'Contrabass Clarinet', family: 'Woodwind', sortOrder: 12 },
    { name: 'Soprano Saxophone', family: 'Woodwind', sortOrder: 13 },
    { name: 'Alto Saxophone', family: 'Woodwind', sortOrder: 14 },
    { name: 'Tenor Saxophone', family: 'Woodwind', sortOrder: 15 },
    { name: 'Baritone Saxophone', family: 'Woodwind', sortOrder: 16 },
    { name: 'Cornet', family: 'Brass', sortOrder: 20 },
    { name: 'Trumpet', family: 'Brass', sortOrder: 21 },
    { name: 'Flugelhorn', family: 'Brass', sortOrder: 22 },
    { name: 'French Horn', family: 'Brass', sortOrder: 23 },
    { name: 'Trombone', family: 'Brass', sortOrder: 24 },
    { name: 'Bass Trombone', family: 'Brass', sortOrder: 25 },
    { name: 'Euphonium', family: 'Brass', sortOrder: 26 },
    { name: 'Baritone', family: 'Brass', sortOrder: 27 },
    { name: 'Tuba', family: 'Brass', sortOrder: 28 },
    { name: 'Percussion', family: 'Percussion', sortOrder: 30 },
    { name: 'Timpani', family: 'Percussion', sortOrder: 31 },
    { name: 'Mallets', family: 'Percussion', sortOrder: 32 },
    { name: 'Drum Set', family: 'Percussion', sortOrder: 33 },
    { name: 'String Bass', family: 'String', sortOrder: 40 },
    { name: 'Piano', family: 'Keyboard', sortOrder: 41 },
  ];

  for (const inst of instruments) {
    await prisma.instrument.upsert({
      where: { name: inst.name },
      update: {},
      create: inst,
    });
  }

  console.log(`✅ Created ${instruments.length} instruments`);

  // 4.5. Smart Upload Settings - Database-driven configuration
  const defaultSettings = [
    // LLM Provider Configuration
    { 
      key: 'llm_provider', 
      value: process.env.LLM_PROVIDER || 'ollama',
      description: 'AI provider for metadata extraction: openai, anthropic, openrouter, gemini, ollama, or custom'
    },
    { 
      key: 'llm_endpoint_url', 
      value: (() => {
        const seedProvider = (process.env.LLM_PROVIDER || 'ollama') as LLMProviderValue;
        return process.env.LLM_ENDPOINT_URL || process.env.LLM_OLLAMA_ENDPOINT || getDefaultEndpointForProvider(seedProvider);
      })(),
      description: 'Custom endpoint URL for the LLM provider'
    },
    // Model Configuration
    { 
      key: 'llm_vision_model', 
      value: process.env.LLM_VISION_MODEL || 'llama3.2-vision',
      description: 'Vision model for first-pass metadata extraction from PDF images'
    },
    { 
      key: 'llm_verification_model', 
      value: process.env.LLM_VERIFICATION_MODEL || 'qwen2.5:7b',
      description: 'Verification model for second-pass confidence checking'
    },
    // Smart Upload Thresholds & Limits
    { 
      key: 'smart_upload_confidence_threshold', 
      value: '70',
      description: 'Minimum confidence score (0-100) to accept metadata without verification'
    },
    { 
      key: 'smart_upload_auto_approve_threshold', 
      value: '90',
      description: 'Confidence score (0-100) required for automatic approval without review'
    },
    { 
      key: 'smart_upload_rate_limit_rpm', 
      value: '10',
      description: 'Rate limit: maximum LLM requests per minute'
    },
    { 
      key: 'smart_upload_max_concurrent', 
      value: '3',
      description: 'Maximum number of concurrent upload processing jobs'
    },
    { 
      key: 'smart_upload_max_pages', 
      value: '20',
      description: 'Maximum number of PDF pages to analyze with LLM'
    },
    { 
      key: 'smart_upload_max_file_size_mb', 
      value: '50',
      description: 'Maximum file size in MB for uploaded PDFs'
    },
    { 
      key: 'smart_upload_allowed_mime_types', 
      value: JSON.stringify(['application/pdf']),
      description: 'JSON array of allowed MIME types for upload'
    },
    // Model Parameters (JSON blobs for provider-specific settings)
    { 
      key: 'vision_model_params', 
      value: JSON.stringify({ temperature: 0.1, max_tokens: 4000 }),
      description: 'JSON parameters for vision model (temperature, max_tokens, etc.)'
    },
    { 
      key: 'verification_model_params', 
      value: JSON.stringify({ temperature: 0.1, max_tokens: 4000 }),
      description: 'JSON parameters for verification model'
    },
    // Legacy compatibility keys (for smooth migration)
    { 
      key: 'llm_ollama_endpoint', 
      value: process.env.LLM_OLLAMA_ENDPOINT || 'http://localhost:11434',
      description: '[Deprecated] Use llm_endpoint_url instead'
    },
    { 
      key: 'llm_custom_base_url', 
      value: process.env.LLM_CUSTOM_BASE_URL || '',
      description: '[Deprecated] Use llm_endpoint_url instead'
    },
    { 
      key: 'llm_confidence_threshold', 
      value: '70',
      description: '[Deprecated] Use smart_upload_confidence_threshold instead'
    },
    { 
      key: 'llm_two_pass_enabled', 
      value: 'true',
      description: 'Enable two-pass verification for low-confidence extractions'
    },
    { 
      key: 'llm_rate_limit_rpm', 
      value: '10',
      description: '[Deprecated] Use smart_upload_rate_limit_rpm instead'
    },
    { 
      key: 'llm_auto_approve_threshold', 
      value: '90',
      description: '[Deprecated] Use smart_upload_auto_approve_threshold instead'
    },
    { 
      key: 'llm_skip_parse_threshold', 
      value: '60',
      description: 'Confidence threshold below which to skip auto-parsing'
    },
    // System Prompts
    { 
      key: 'llm_vision_system_prompt', 
      value: '',
      description: 'Custom system prompt for vision model (leave empty for default)'
    },
    { 
      key: 'llm_verification_system_prompt', 
      value: '',
      description: 'Custom system prompt for verification model (leave empty for default)'
    },
    { 
      key: 'llm_vision_model_params', 
      value: JSON.stringify({}),
      description: '[Deprecated] Use vision_model_params instead'
    },
    { 
      key: 'llm_verification_model_params', 
      value: JSON.stringify({}),
      description: '[Deprecated] Use verification_model_params instead'
    },
  ];

  for (const setting of defaultSettings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: { 
        value: setting.value,
        description: setting.description,
      },
      create: { 
        key: setting.key, 
        value: setting.value,
        description: setting.description,
      },
    });
  }

  console.log(`✅ Created/updated ${defaultSettings.length} Smart Upload settings`);

  // 5. Sections
  const sections = [
    { name: 'Woodwinds', sortOrder: 1 },
    { name: 'Brass', sortOrder: 2 },
    { name: 'Percussion', sortOrder: 3 },
  ];

  for (const sec of sections) {
    await prisma.section.upsert({
      where: { name: sec.name },
      update: {},
      create: sec,
    });
  }

  console.log(`✅ Created ${sections.length} sections`);

  // 6. Super Admin User
  const adminEmail = process.env.SUPER_ADMIN_EMAIL || 'admin@eccb.org';
  const adminPassword = process.env.SUPER_ADMIN_PASSWORD as string;

  try {
    assertSuperAdminPasswordPresentForSeed();
  } catch (_err: unknown) {
    console.error('❌ SUPER_ADMIN_PASSWORD is not set. For security, you must provide a password for the root SUPER_ADMIN user before running `npm run db:seed`.');
    console.error('   Add the following to your `.env` file (do NOT commit real passwords):');
    console.error('     SUPER_ADMIN_EMAIL="admin@eccb.org"');
    console.error('     SUPER_ADMIN_PASSWORD="your-secure-admin-password"');
    process.exit(1);
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({ 
    where: { email: adminEmail },
    include: { roles: true }
  });
  
  if (existingUser) {
    console.log(`✅ Admin user already exists: ${adminEmail}`);

    // Ensure email is verified so admin can sign in immediately
    if (!existingUser.emailVerified) {
      await prisma.user.update({ where: { id: existingUser.id }, data: { emailVerified: true } });
      console.log(`✅ Marked admin user email as verified: ${adminEmail}`);
    }

    // Ensure password exists (use SUPER_ADMIN_PASSWORD when present) — idempotent and safe for development
    if (!existingUser.password && adminPassword) {
      const hashed = await bcrypt.hash(adminPassword, 10);
      await prisma.user.update({ where: { id: existingUser.id }, data: { password: hashed } });
      console.log(`✅ Set password for existing admin user from SUPER_ADMIN_PASSWORD`);
    }

    // Ensure the user has the super admin role
    const hasSuperAdminRole = existingUser.roles.some((ur) => ur.roleId === superAdminRole.id);
    
    if (!hasSuperAdminRole) {
      await prisma.userRole.create({
        data: { userId: existingUser.id, roleId: superAdminRole.id },
      });
      console.log('✅ Added SUPER_ADMIN role to existing user');
    }
    
    // Ensure member profile exists
    const existingMember = await prisma.member.findUnique({ where: { userId: existingUser.id } });
    
    if (!existingMember) {
      await prisma.member.create({
        data: {
          userId: existingUser.id,
          firstName: 'System',
          lastName: 'Administrator',
          email: adminEmail,
          status: 'ACTIVE',
          joinDate: new Date(),
        },
      });
      console.log('✅ Created member profile for admin user');
    }
  } else {
    try {
      console.log('Creating admin user via Better Auth...');
      const res = await auth.api.signUpEmail({
        body: {
          email: adminEmail,
          password: adminPassword,
          name: 'System Administrator',
        },
      });
      
      if (res.user) {
        // Mark email verified so the seeded admin can sign in immediately
        await prisma.user.update({ where: { id: res.user.id }, data: { emailVerified: true } });

        // As a fallback, ensure a password is present in the DB (Better Auth should handle this,
        // but this guarantees the seeded admin can login with SUPER_ADMIN_PASSWORD)
        const createdUser = await prisma.user.findUnique({ where: { id: res.user.id } });
        if (createdUser && !createdUser.password && adminPassword) {
          const hashed = await bcrypt.hash(adminPassword, 10);
          await prisma.user.update({ where: { id: res.user.id }, data: { password: hashed } });
          console.log('✅ Set password for newly-created admin user from SUPER_ADMIN_PASSWORD');
        }

        await prisma.userRole.create({
          data: { userId: res.user.id, roleId: superAdminRole.id },
        });

        await prisma.member.create({
          data: {
            userId: res.user.id,
            firstName: 'System',
            lastName: 'Administrator',
            email: adminEmail,
            status: 'ACTIVE',
            joinDate: new Date(),
          },
        });
        
        console.log(`✅ Created Super Admin user: ${adminEmail}`);
      }
    } catch (error) {
      console.error('❌ Error creating admin user via Auth API:', error);
      throw error;
    }
  }

  // 10. Digital Music Stand E2E fixture (idempotent)
  //
  // A single MusicPiece + MusicFile with a real, inked, multi-page PDF written to
  // local storage through the app's own storage service. The stand E2E specs
  // resolve this piece by its sentinel catalog number at runtime, so they work on
  // any machine without a hardcoded id. Upserts throughout: re-running the seed
  // neither duplicates nor errors.
  const standFixture = await seedStandE2EFixture(prisma);
  console.log(
    `✅ Stand E2E fixture "${standFixture.pieceId}" (${standFixture.pageCount} pages) at ${standFixture.storageKey}`,
  );

  console.log('🎉 Seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
