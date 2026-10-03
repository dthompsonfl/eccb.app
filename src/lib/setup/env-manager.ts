/**
 * Environment Manager
 *
 * Provides environment variable management for the ECCB platform:
 * - Generate .env files with required variables
 * - Validate environment variables
 * - Support for development and production environments
 * - Secure secrets generation
 * - Update .env.example template
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// =============================================================================
// Constants
// =============================================================================

const ENV_FILE_PATH = join(process.cwd(), '.env');
const ENV_EXAMPLE_PATH = join(process.cwd(), 'env.example');
const MIN_SECRET_LENGTH = 32;

/**
 * Environment type
 */
export type EnvironmentType = 'development' | 'production';

/**
 * Storage driver type
 */
export type StorageDriver = 'LOCAL' | 'S3';

/**
 * Email driver type
 */
export type EmailDriver = 'LOG' | 'SMTP' | 'NONE';

// =============================================================================
// Types
// =============================================================================

/**
 * Environment variable configuration
 */
export interface EnvVariable {
  key: string;
  value: string;
  required: boolean;
  description: string;
  sensitive: boolean;
  default?: string;
}

/**
 * Environment configuration for a specific type
 */
export interface EnvironmentConfig {
  type: EnvironmentType;
  variables: EnvVariable[];
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Validation error
 */
export interface ValidationError {
  key: string;
  message: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  key: string;
  message: string;
}

/**
 * Generated environment result
 */
export interface GenerateResult {
  success: boolean;
  filePath: string;
  message?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default environment variables for development
 */
const DEVELOPMENT_VARS: EnvVariable[] = [
  {
    key: 'NODE_ENV',
    value: 'development',
    required: false,
    description: 'Environment mode',
    sensitive: false,
    default: 'development',
  },
  {
    key: 'PORT',
    value: '3225',
    required: false,
    description: 'Server port (.env-overridable; auto-rolls to next free port when busy)',
    sensitive: false,
    default: '3225',
  },
  {
    key: 'NEXT_PUBLIC_APP_URL',
    value: 'http://localhost:3225',
    required: false,
    description: 'Client-visible app URL',
    sensitive: false,
    default: 'http://localhost:3225',
  },
  {
    key: 'NEXT_PUBLIC_APP_NAME',
    value: 'Emerald Coast Community Band',
    required: false,
    description: 'Client-visible app name',
    sensitive: false,
    default: 'Emerald Coast Community Band',
  },
  {
    key: 'ALLOWED_ORIGINS',
    value: '',
    required: false,
    description:
      'Extra origins this deployment answers on, space/comma separated (LAN IP, Tailscale IP, forwarded public IP), e.g. "http://192.168.1.10:3225 http://100.x.y.z:3225". Required for login to work on any interface other than NEXT_PUBLIC_APP_URL',
    sensitive: false,
  },
  {
    key: 'COOKIE_SECURE',
    value: '',
    required: false,
    description:
      'Session cookie Secure flag. Leave blank to derive from the scheme of NEXT_PUBLIC_APP_URL. Only set false while serving plain HTTP on a trusted network',
    sensitive: false,
  },
  {
    key: 'BIND_HOST',
    value: '0.0.0.0',
    required: false,
    description:
      'Interface the Next.js server binds to. 0.0.0.0 exposes the app on LAN/Tailscale/public addresses; 127.0.0.1 restricts it to this host',
    sensitive: false,
    default: '0.0.0.0',
  },
  {
    key: 'DATABASE_URL',
    value: '',
    required: true,
    description: 'Prisma database URL (mysql://user:pass@host:port/db)',
    sensitive: true,
  },
  {
    key: 'REDIS_URL',
    value: 'redis://localhost:6379',
    required: false,
    description: 'Redis connection URL',
    sensitive: true,
    default: 'redis://localhost:6379',
  },
  {
    key: 'AUTH_SECRET',
    value: '',
    required: true,
    description: 'Authentication secret (32+ characters)',
    sensitive: true,
  },
  {
    key: 'BETTER_AUTH_SECRET',
    value: '',
    required: true,
    description: 'Better Auth secret (32+ characters)',
    sensitive: true,
  },
  {
    key: 'AUTH_URL',
    value: 'http://localhost:3225',
    required: false,
    description: 'Server auth URL',
    sensitive: false,
    default: 'http://localhost:3225',
  },
  {
    key: 'BETTER_AUTH_URL',
    value: 'http://localhost:3225',
    required: false,
    description: 'Better Auth URL',
    sensitive: false,
    default: 'http://localhost:3225',
  },
  {
    key: 'SUPER_ADMIN_EMAIL',
    value: 'admin@eccb.org',
    required: false,
    description: 'Super admin email for seeding',
    sensitive: false,
    default: 'admin@eccb.org',
  },
  {
    key: 'SUPER_ADMIN_PASSWORD',
    value: '',
    required: false,
    description: 'Super admin password (do not commit)',
    sensitive: true,
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    value: '',
    required: false,
    description: 'Google OAuth client ID',
    sensitive: true,
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    value: '',
    required: false,
    description: 'Google OAuth client secret',
    sensitive: true,
  },
  {
    key: 'NEXT_PUBLIC_GOOGLE_AUTH_ENABLED',
    value: 'false',
    required: false,
    description: 'Enable Google auth',
    sensitive: false,
    default: 'false',
  },
  {
    key: 'STORAGE_DRIVER',
    value: 'LOCAL',
    required: false,
    description: 'Storage driver (LOCAL or S3)',
    sensitive: false,
    default: 'LOCAL',
  },
  {
    key: 'LOCAL_STORAGE_PATH',
    value: './storage',
    required: false,
    description: 'Local storage path',
    sensitive: false,
    default: './storage',
  },
  {
    key: 'MAX_FILE_SIZE',
    value: '52428800',
    required: false,
    description: 'Max file size in bytes (50MB)',
    sensitive: false,
    default: '52428800',
  },
  {
    key: 'S3_ENDPOINT',
    value: '',
    required: false,
    description: 'S3/MinIO endpoint URL',
    sensitive: false,
  },
  {
    key: 'S3_BUCKET_NAME',
    value: '',
    required: false,
    description: 'S3 bucket name',
    sensitive: false,
  },
  {
    key: 'S3_REGION',
    value: 'us-east-1',
    required: false,
    description: 'S3 region',
    sensitive: false,
    default: 'us-east-1',
  },
  {
    key: 'S3_ACCESS_KEY_ID',
    value: '',
    required: false,
    description: 'S3 access key ID',
    sensitive: true,
  },
  {
    key: 'S3_SECRET_ACCESS_KEY',
    value: '',
    required: false,
    description: 'S3 secret access key',
    sensitive: true,
  },
  {
    key: 'S3_FORCE_PATH_STYLE',
    value: 'true',
    required: false,
    description: 'Force path style (for MinIO)',
    sensitive: false,
    default: 'true',
  },
  {
    key: 'EMAIL_DRIVER',
    value: 'LOG',
    required: false,
    description: 'Email driver (LOG, SMTP, or NONE)',
    sensitive: false,
    default: 'LOG',
  },
  {
    key: 'SMTP_HOST',
    value: '',
    required: false,
    description: 'SMTP host',
    sensitive: false,
  },
  {
    key: 'SMTP_PORT',
    value: '587',
    required: false,
    description: 'SMTP port',
    sensitive: false,
    default: '587',
  },
  {
    key: 'SMTP_USER',
    value: '',
    required: false,
    description: 'SMTP username',
    sensitive: true,
  },
  {
    key: 'SMTP_PASSWORD',
    value: '',
    required: false,
    description: 'SMTP password',
    sensitive: true,
  },
  {
    key: 'SMTP_SECURE',
    value: 'false',
    required: false,
    description: 'Use TLS/SSL for SMTP',
    sensitive: false,
    default: 'false',
  },
  {
    key: 'SMTP_FROM',
    value: 'noreply@eccb.app',
    required: false,
    description: 'From email address',
    sensitive: false,
    default: 'noreply@eccb.app',
  },
  {
    key: 'VAPID_PUBLIC_KEY',
    value: '',
    required: false,
    description: 'VAPID public key for push notifications',
    sensitive: false,
  },
  {
    key: 'VAPID_PRIVATE_KEY',
    value: '',
    required: false,
    description: 'VAPID private key for push notifications',
    sensitive: true,
  },
  {
    key: 'ENABLE_VIRUS_SCAN',
    value: 'false',
    required: false,
    description: 'Enable virus scanning (requires ClamAV)',
    sensitive: false,
    default: 'false',
  },
  {
    key: 'CLAMAV_HOST',
    value: 'localhost',
    required: false,
    description: 'ClamAV host',
    sensitive: false,
    default: 'localhost',
  },
  {
    key: 'CLAMAV_PORT',
    value: '3310',
    required: false,
    description: 'ClamAV port',
    sensitive: false,
    default: '3310',
  },
  {
    key: 'LOG_DIR',
    value: './logs',
    required: false,
    description: 'Log directory',
    sensitive: false,
    default: './logs',
  },
  {
    key: 'LOG_RETENTION_DAYS',
    value: '7',
    required: false,
    description: 'Log retention days',
    sensitive: false,
    default: '7',
  },
  {
    key: 'LOG_MAX_SIZE_MB',
    value: '100',
    required: false,
    description: 'Max log file size in MB',
    sensitive: false,
    default: '100',
  },
  {
    key: 'LOG_ROTATION',
    value: 'daily',
    required: false,
    description: 'Log rotation mode',
    sensitive: false,
    default: 'daily',
  },
  {
    key: 'WORKER_HEALTH_PORT',
    value: '3227',
    required: false,
    description: 'Worker health check port',
    sensitive: false,
    default: '3227',
  },
  {
    key: 'PROCESS_MANAGER_HEALTH_PORT',
    value: '3228',
    required: false,
    description: 'Process manager health port',
    sensitive: false,
    default: '3228',
  },
  {
    key: 'RESTART_CRASHED_PROCESSES',
    value: 'false',
    required: false,
    description: 'Auto-restart crashed processes',
    sensitive: false,
    default: 'false',
  },
  {
    key: 'SCHEDULER_INTERVAL_MS',
    value: '60000',
    required: false,
    description: 'Scheduler tick interval',
    sensitive: false,
    default: '60000',
  },
  {
    key: 'CLEANUP_INTERVAL_MS',
    value: '86400000',
    required: false,
    description: 'Cleanup interval (24 hours)',
    sensitive: false,
    default: '86400000',
  },
  {
    key: 'ENABLE_WORKER',
    value: 'true',
    required: false,
    description: 'Start the background worker fleet (email, scheduler, Smart Upload, OCR). Set false only for a web-only instance.',
    sensitive: false,
    default: 'true',
  },
  {
    key: 'ENABLE_OCR_WORKER',
    value: 'true',
    required: false,
    description:
      'Start the dedicated OCR fallback worker. Only needed for the admin re-OCR endpoint (POST /api/admin/uploads/review/[id]/reocr); Smart Upload OCRs inline regardless.',
    sensitive: false,
    default: 'true',
  },
];

/**
 * Production-specific overrides
 */
const PRODUCTION_OVERRIDES: Partial<EnvVariable>[] = [
  {
    key: 'NODE_ENV',
    value: 'production',
  },
  {
    key: 'EMAIL_DRIVER',
    value: 'SMTP',
  },
  {
    key: 'LOG_ROTATION',
    value: 'daily',
  },
  {
    key: 'LOG_RETENTION_DAYS',
    value: '30',
  },
  {
    key: 'ENABLE_VIRUS_SCAN',
    value: 'true',
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a secure random secret
 */
function generateSecureSecret(length: number = 32): string {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);

  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[array[i] % charset.length];
  }

  return result;
}

/**
 * Read existing .env file
 */
function readEnvFile(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();

  if (!existsSync(filePath)) {
    return vars;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        vars.set(key, value);
      }
    }
  } catch {
    // Ignore errors, return empty map
  }

  return vars;
}

/**
 * Format variable for .env file
 */
function formatEnvVariable(variable: EnvVariable): string {
  const comment = `# ${variable.description}${variable.required ? ' [Required]' : ''}`;
  const line = `${variable.key}="${variable.value}"`;

  return `${comment}\n${line}`;
}

// =============================================================================
// Environment Manager Class
// =============================================================================

/**
 * Environment Manager
 *
 * Manages environment variables for the application.
 */
export class EnvironmentManager {
  private variables: EnvVariable[];
  private existingValues: Map<string, string>;

  constructor() {
    this.variables = [...DEVELOPMENT_VARS];
    this.existingValues = new Map();
  }

  /**
   * Load existing values from .env file
   */
  loadExisting(): void {
    this.existingValues = readEnvFile(ENV_FILE_PATH);
  }

  /**
   * Set environment type (development/production)
   */
  setEnvironment(type: EnvironmentType): void {
    if (type === 'production') {
      // Apply production overrides
      for (const override of PRODUCTION_OVERRIDES) {
        const variable = this.variables.find((v) => v.key === override.key);
        if (variable) {
          variable.value = override.value || variable.value;
        }
      }
    }
  }

  /**
   * Set a specific variable value
   */
  setVariable(key: string, value: string): void {
    const variable = this.variables.find((v) => v.key === key);
    if (variable) {
      variable.value = value;
    }
  }

  /**
   * Get variable value
   */
  getVariable(key: string): string | undefined {
    const variable = this.variables.find((v) => v.key === key);
    return variable?.value;
  }

  /**
   * Generate secure secrets for required keys
   */
  generateSecrets(): void {
    const secretKeys = ['AUTH_SECRET', 'BETTER_AUTH_SECRET'];

    for (const key of secretKeys) {
      const variable = this.variables.find((v) => v.key === key);
      if (variable && (!variable.value || variable.value.length < MIN_SECRET_LENGTH)) {
        variable.value = generateSecureSecret(MIN_SECRET_LENGTH);
      }
    }
  }

  /**
   * Set database URL
   */
  setDatabaseUrl(url: string): void {
    this.setVariable('DATABASE_URL', url);
  }

  /**
   * Set storage configuration
   */
  setStorageConfig(driver: StorageDriver, config?: {
    endpoint?: string;
    bucket?: string;
    accessKey?: string;
    secretKey?: string;
  }): void {
    this.setVariable('STORAGE_DRIVER', driver);

    if (driver === 'S3' && config) {
      if (config.endpoint) this.setVariable('S3_ENDPOINT', config.endpoint);
      if (config.bucket) this.setVariable('S3_BUCKET_NAME', config.bucket);
      if (config.accessKey) this.setVariable('S3_ACCESS_KEY_ID', config.accessKey);
      if (config.secretKey) this.setVariable('S3_SECRET_ACCESS_KEY', config.secretKey);
    }
  }

  /**
   * Set email configuration
   */
  setEmailConfig(driver: EmailDriver, config?: {
    host?: string;
    port?: string;
    user?: string;
    password?: string;
    from?: string;
  }): void {
    this.setVariable('EMAIL_DRIVER', driver);

    if (driver === 'SMTP' && config) {
      if (config.host) this.setVariable('SMTP_HOST', config.host);
      if (config.port) this.setVariable('SMTP_PORT', config.port);
      if (config.user) this.setVariable('SMTP_USER', config.user);
      if (config.password) this.setVariable('SMTP_PASSWORD', config.password);
      if (config.from) this.setVariable('SMTP_FROM', config.from);
    }
  }

  /**
   * Validate environment variables
   */
  validate(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    for (const variable of this.variables) {
      // Check required variables
      if (variable.required && !variable.value) {
        errors.push({
          key: variable.key,
          message: `${variable.key} is required but not set`,
        });
        continue;
      }

      // Check secret length
      if (variable.sensitive && variable.value) {
        if (variable.value.length < MIN_SECRET_LENGTH) {
          warnings.push({
            key: variable.key,
            message: `${variable.key} should be at least ${MIN_SECRET_LENGTH} characters`,
          });
        }
      }

      // Check database URL format
      if (variable.key === 'DATABASE_URL' && variable.value) {
        if (!variable.value.match(/^(mysql|mariadb|postgresql|postgres|sqlite):\/\//)) {
          errors.push({
            key: variable.key,
            message: 'DATABASE_URL must be a valid database connection string',
          });
        }
      }

      // Check storage driver
      if (variable.key === 'STORAGE_DRIVER' && variable.value) {
        if (!['LOCAL', 'S3'].includes(variable.value)) {
          errors.push({
            key: variable.key,
            message: 'STORAGE_DRIVER must be LOCAL or S3',
          });
        }
      }

      // Check email driver
      if (variable.key === 'EMAIL_DRIVER' && variable.value) {
        if (!['LOG', 'SMTP', 'NONE'].includes(variable.value)) {
          errors.push({
            key: variable.key,
            message: 'EMAIL_DRIVER must be LOG, SMTP, or NONE',
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Generate .env file content
   */
  generateContent(): string {
    const lines: string[] = [
      '# ==============================================================================',
      '# ECCB Platform - Environment Variables',
      '# Generated by Environment Manager',
      '# ==============================================================================',
      '',
    ];

    // Group variables by category
    const categories = [
      { name: 'APP & ENVIRONMENT', keys: ['NODE_ENV', 'PORT', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_APP_NAME', 'APP_VERSION'] },
      { name: 'DATABASE & CACHE', keys: ['DATABASE_URL', 'REDIS_URL'] },
      { name: 'AUTHENTICATION', keys: ['AUTH_SECRET', 'BETTER_AUTH_SECRET', 'AUTH_URL', 'BETTER_AUTH_URL'] },
      { name: 'SUPER ADMIN', keys: ['SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD', 'SUPER_ADMIN_DEFAULT_PASSWORD', 'ADMIN_EMAIL'] },
      { name: 'OAUTH', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_GOOGLE_AUTH_ENABLED'] },
      { name: 'STORAGE', keys: ['STORAGE_DRIVER', 'LOCAL_STORAGE_PATH', 'MAX_FILE_SIZE', 'S3_ENDPOINT', 'S3_BUCKET_NAME', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'] },
      { name: 'EMAIL', keys: ['EMAIL_DRIVER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'SMTP_FROM'] },
      { name: 'PUSH NOTIFICATIONS', keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
      { name: 'VIRUS SCANNING', keys: ['ENABLE_VIRUS_SCAN', 'CLAMAV_HOST', 'CLAMAV_PORT'] },
      { name: 'LOGGING', keys: ['LOG_DIR', 'LOG_RETENTION_DAYS', 'LOG_MAX_SIZE_MB', 'LOG_ROTATION'] },
      { name: 'WORKERS', keys: ['WORKER_HEALTH_PORT', 'PROCESS_MANAGER_HEALTH_PORT', 'RESTART_CRASHED_PROCESSES', 'SCHEDULER_INTERVAL_MS', 'CLEANUP_INTERVAL_MS', 'ENABLE_WORKER', 'ENABLE_OCR_WORKER'] },
    ];

    for (const category of categories) {
      lines.push(`# ------------------------------------------------------------------------------`);
      lines.push(`# ${category.name}`);
      lines.push(`# ------------------------------------------------------------------------------`);
      lines.push('');

      for (const key of category.keys) {
        const variable = this.variables.find((v) => v.key === key);
        if (variable) {
          lines.push(formatEnvVariable(variable));
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Write .env file
   */
  writeEnvFile(path: string = ENV_FILE_PATH): GenerateResult {
    try {
      const content = this.generateContent();
      writeFileSync(path, content, 'utf-8');

      return {
        success: true,
        filePath: path,
        message: `Environment file generated at ${path}`,
      };
    } catch (error) {
      return {
        success: false,
        filePath: path,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update .env.example template
   */
  updateEnvExample(): GenerateResult {
    try {
      const lines: string[] = [
        '# ==============================================================================',
        '# ECCB Platform - Environment Variables Example',
        '# Copy this file to .env and replace the placeholder values with your own.',
        '# ==============================================================================',
        '',
      ];

      // Generate with placeholder values for sensitive fields
      const exampleVars = this.variables.map((v) => {
        if (v.sensitive && v.required) {
          return { ...v, value: `YOUR_${v.key}_HERE` };
        }
        return v;
      });

      const categories = [
        { name: 'APP & ENVIRONMENT', keys: ['NODE_ENV', 'PORT', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_APP_NAME', 'APP_VERSION'] },
        { name: 'DATABASE & CACHE', keys: ['DATABASE_URL', 'REDIS_URL'] },
        { name: 'AUTHENTICATION', keys: ['AUTH_SECRET', 'BETTER_AUTH_SECRET', 'AUTH_URL', 'BETTER_AUTH_URL'] },
        { name: 'SUPER ADMIN (Seeding)', keys: ['SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD', 'SUPER_ADMIN_DEFAULT_PASSWORD', 'ADMIN_EMAIL'] },
        { name: 'OAUTH (Google)', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_GOOGLE_AUTH_ENABLED'] },
        { name: 'STORAGE (Local or S3)', keys: ['STORAGE_DRIVER', 'LOCAL_STORAGE_PATH', 'MAX_FILE_SIZE', 'S3_ENDPOINT', 'S3_BUCKET_NAME', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'] },
        { name: 'EMAIL (SMTP)', keys: ['EMAIL_DRIVER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'SMTP_FROM'] },
        { name: 'PUSH NOTIFICATIONS', keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
        { name: 'VIRUS SCANNING (ClamAV)', keys: ['ENABLE_VIRUS_SCAN', 'CLAMAV_HOST', 'CLAMAV_PORT'] },
        { name: 'LOGGING', keys: ['LOG_DIR', 'LOG_RETENTION_DAYS', 'LOG_MAX_SIZE_MB', 'LOG_ROTATION'] },
        { name: 'WORKERS & PROCESS MANAGEMENT', keys: ['WORKER_HEALTH_PORT', 'PROCESS_MANAGER_HEALTH_PORT', 'RESTART_CRASHED_PROCESSES', 'SCHEDULER_INTERVAL_MS', 'CLEANUP_INTERVAL_MS', 'ENABLE_WORKER', 'ENABLE_OCR_WORKER'] },
      ];

      for (const category of categories) {
        lines.push(`# ------------------------------------------------------------------------------`);
        lines.push(`# ${category.name}`);
        lines.push(`# ------------------------------------------------------------------------------`);
        lines.push('');

        for (const key of category.keys) {
          const variable = exampleVars.find((v) => v.key === key);
          if (variable) {
            lines.push(formatEnvVariable(variable));
          }
        }

        lines.push('');
      }

      writeFileSync(ENV_EXAMPLE_PATH, lines.join('\n'), 'utf-8');

      return {
        success: true,
        filePath: ENV_EXAMPLE_PATH,
        message: `Example file updated at ${ENV_EXAMPLE_PATH}`,
      };
    } catch (error) {
      return {
        success: false,
        filePath: ENV_EXAMPLE_PATH,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all variables
   */
  getVariables(): EnvVariable[] {
    return [...this.variables];
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new EnvironmentManager instance
 */
export function createEnvironmentManager(): EnvironmentManager {
  return new EnvironmentManager();
}

/**
 * Quick validation of current environment
 */
export function validateEnvironment(): ValidationResult {
  const manager = createEnvironmentManager();
  manager.loadExisting();
  return manager.validate();
}

/**
 * Generate .env file with defaults
 */
export function generateEnvFile(options?: {
  databaseUrl?: string;
  environment?: EnvironmentType;
  storage?: {
    driver: StorageDriver;
    config?: Parameters<EnvironmentManager['setStorageConfig']>[1];
  };
  email?: {
    driver: EmailDriver;
    config?: Parameters<EnvironmentManager['setEmailConfig']>[1];
  };
}): GenerateResult {
  const manager = createEnvironmentManager();

  if (options?.environment) {
    manager.setEnvironment(options.environment);
  }

  if (options?.databaseUrl) {
    manager.setDatabaseUrl(options.databaseUrl);
  }

  if (options?.storage) {
    manager.setStorageConfig(options.storage.driver, options.storage.config);
  }

  if (options?.email) {
    manager.setEmailConfig(options.email.driver, options.email.config);
  }

  manager.generateSecrets();

  const validation = manager.validate();
  if (!validation.valid) {
    return {
      success: false,
      filePath: ENV_FILE_PATH,
      message: `Validation errors: ${validation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  return manager.writeEnvFile();
}

/**
 * Generate a secure secret
 */
export function generateSecret(length: number = 32): string {
  return generateSecureSecret(length);
}

/**
 * Update a single key in the .env file.
 *
 * This is used to persist runtime modifications (like disabling setup mode) so
 * that the next restart picks up the new value.
 */
export function setEnvVariable(key: string, value: string, envPath: string = ENV_FILE_PATH): boolean {
  try {
    if (!existsSync(envPath)) {
      return false;
    }

    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    let found = false;

    const updated = lines.map((line) => {
      const trimmed = line.trim();
      // Match keys at the start of the line (allow optional whitespace and comments)
      if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`${key} =`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!found) {
      updated.push(`${key}=${value}`);
    }

    writeFileSync(envPath, updated.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Export
// =============================================================================

export default {
  EnvironmentManager,
  createEnvironmentManager,
  validateEnvironment,
  generateEnvFile,
  generateSecret,
  setEnvVariable,
};
