import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  
  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RATE_LIMIT_FAIL_OPEN: z.string().default('false').transform((val) => `${val}`.trim().split(/\s+/)[0].toLowerCase() === 'true'),

  // WebSocket / Socket.IO worker
  /** Set to "true" to enable the standalone Socket.IO process (socket-worker). */
  ENABLE_WEBSOCKETS: z.string().default('false').transform((val) => `${val}`.trim().split(/\s+/)[0].toLowerCase() === 'true'),
  /** Port the standalone Socket.IO worker listens on. */
  SOCKET_PORT: z.coerce.number().int().positive().default(3005),
  
  // Better Auth
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  AUTH_URL: z.string().url().default('http://localhost:3000'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  
  // Super Admin Credentials
  SUPER_ADMIN_EMAIL: z.string().email().default('admin@eccb.org'),
  // No default password - must be explicitly set, especially in production
  SUPER_ADMIN_PASSWORD: z.string().min(8, 'SUPER_ADMIN_PASSWORD must be at least 8 characters').optional(),

  // OAuth (optional)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  
  // Storage Configuration
  STORAGE_DRIVER: z.enum(['LOCAL', 'S3']).default('LOCAL'),
  LOCAL_STORAGE_PATH: z.string().default('./storage'),
  MAX_FILE_SIZE: z.coerce.number().default(52428800), // 50MB default

  // S3/MinIO Storage (optional when using LOCAL storage)
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET_NAME: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default('true').transform(val => val === 'true'),
  
  // Email Configuration
  EMAIL_DRIVER: z.enum(['SMTP', 'LOG', 'NONE']).default('LOG'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().email().default('noreply@eccb.app'),
  SMTP_SECURE: z.string().default('false').transform((val) => `${val}`.trim().split(/\s+/)[0].toLowerCase() === 'true'),
  
  // App Config
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("Emerald Coast Community Band"),

  // Setup Configuration
  SETUP_MODE: z.string().default('false').transform((val) => `${val}`.trim().split(/\s+/)[0].toLowerCase() === 'true'),
  SETUP_TOKEN: z.string().optional(),
  
  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Push Notifications (VAPID keys - optional)
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  
  // File scanning (ClamAV - optional)
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  ENABLE_VIRUS_SCAN: z.string().default('false').transform((val) => `${val}`.trim().split(/\s+/)[0].toLowerCase() === 'true'),
  
  // LLM Configuration for Smart Upload
  LLM_OLLAMA_ENDPOINT: z.string().url().default('http://localhost:11434'),
  LLM_VISION_MODEL: z.string().default('llama3.2-vision'),
  LLM_VERIFICATION_MODEL: z.string().default('qwen2.5:7b'),
});

function validateEnv() {
  const parsed = envSchema.safeParse(process.env);
  
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }
  
  const data = parsed.data;
  
  // Validate S3 credentials when using S3 storage
  if (data.STORAGE_DRIVER === 'S3') {
    if (!data.S3_ACCESS_KEY_ID || !data.S3_SECRET_ACCESS_KEY) {
      console.error('❌ S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER is S3');
      throw new Error('S3 credentials required for S3 storage driver');
    }
    if (!data.S3_ENDPOINT || !data.S3_BUCKET_NAME) {
      console.error('❌ S3_ENDPOINT and S3_BUCKET_NAME are required when STORAGE_DRIVER is S3');
      throw new Error('S3 endpoint and bucket required for S3 storage driver');
    }
  }
  
  // Validate SMTP credentials when using SMTP email driver
  if (data.EMAIL_DRIVER === 'SMTP') {
    if (!data.SMTP_HOST) {
      console.error('❌ SMTP_HOST is required when EMAIL_DRIVER is SMTP');
      throw new Error('SMTP host required for SMTP email driver');
    }
    if (!data.SMTP_PORT) {
      console.error('❌ SMTP_PORT is required when EMAIL_DRIVER is SMTP');
      throw new Error('SMTP port required for SMTP email driver');
    }
  }
  
  // Require SUPER_ADMIN_PASSWORD in production
  if (data.NODE_ENV === 'production' && !data.SUPER_ADMIN_PASSWORD) {
    console.error('❌ SUPER_ADMIN_PASSWORD is required in production');
    throw new Error('SUPER_ADMIN_PASSWORD must be set in production environment');
  }

  return data;
}

export const env = validateEnv();

export type Env = z.infer<typeof envSchema>;
