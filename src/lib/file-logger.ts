/**
 * File Logger for Production Log Rotation
 * 
 * Features:
 * - Write logs to file in production
 * - Log rotation (daily or size-based)
 * - Retention policy (7 days default)
 * - Log directory from env
 */

import fs from 'fs';
import path from 'path';
import { logger, type LogLevel, type LogContext } from '@/lib/logger';

// Configuration
const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);
const LOG_MAX_SIZE_MB = parseInt(process.env.LOG_MAX_SIZE_MB || '100', 10);
const LOG_ROTATION = process.env.LOG_ROTATION || 'daily'; // 'daily' | 'size' | 'both'
const isProduction = process.env.NODE_ENV === 'production';

// Track current log file
let currentLogFile: string | null = null;
let currentLogStream: fs.WriteStream | null = null;
let currentLogDate: string | null = null;
let currentLogSize = 0;
let isFileLoggerInitialized = false;
let cleanupIntervalStarted = false;

/**
 * Get current date string for log filename
 */
function getDateString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Get log filename for current date
 */
function getLogFilename(): string {
  const dateStr = getDateString();
  return `app-${dateStr}.log`;
}

/**
 * Get full path to log file
 */
function getLogFilePath(): string {
  return path.join(LOG_DIR, getLogFilename());
}

/**
 * Ensure log directory exists
 */
function ensureLogDirectory(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Check if log rotation is needed
 */
function needsRotation(): boolean {
  if (!currentLogFile) return true;
  
  // Check date rotation
  if (LOG_ROTATION === 'daily' || LOG_ROTATION === 'both') {
    const today = getDateString();
    if (currentLogDate !== today) {
      return true;
    }
  }
  
  // Check size rotation
  if (LOG_ROTATION === 'size' || LOG_ROTATION === 'both') {
    const maxSizeBytes = LOG_MAX_SIZE_MB * 1024 * 1024;
    if (currentLogSize >= maxSizeBytes) {
      return true;
    }
  }
  
  return false;
}

/**
 * Rotate log file if needed
 */
function rotateLogFile(): void {
  if (!needsRotation()) return;
  
  ensureLogDirectory();
  
  // Close existing stream if any
  if (currentLogStream) {
    currentLogStream.end();
    currentLogStream = null;
  }

  currentLogFile = getLogFilePath();
  currentLogDate = getDateString();
  currentLogSize = 0;
  
  // Check if file exists and get its size for accurate rotation
  if (fs.existsSync(currentLogFile)) {
    const stats = fs.statSync(currentLogFile);
    currentLogSize = stats.size;
  }

  // Create new stream
  try {
    currentLogStream = fs.createWriteStream(currentLogFile, { flags: 'a', encoding: 'utf-8' });
    currentLogStream.on('error', (err) => {
      console.error('File logger stream error:', err);
    });
  } catch (error) {
    console.error('Failed to create log stream:', error);
  }
}

/**
 * Delete old log files based on retention policy
 */
function cleanupOldLogs(): void {
  if (!fs.existsSync(LOG_DIR)) return;
  
  const files = fs.readdirSync(LOG_DIR);
  const now = Date.now();
  const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  
  for (const file of files) {
    if (!file.startsWith('app-') || !file.endsWith('.log')) continue;
    
    const filePath = path.join(LOG_DIR, file);
    const stats = fs.statSync(filePath);
    const age = now - stats.mtime.getTime();
    
    if (age > retentionMs) {
      try {
        fs.unlinkSync(filePath);
        logger.debug(`Deleted old log file: ${file}`);
      } catch (error) {
        logger.error(`Failed to delete old log file: ${file}`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

/**
 * Lazily initialize file logging resources in production.
 * Avoids side effects at module-load/build-trace time.
 */
function initializeFileLogger(): void {
  if (!isProduction || isFileLoggerInitialized) {
    return;
  }

  ensureLogDirectory();
  rotateLogFile();
  cleanupOldLogs();

  if (!cleanupIntervalStarted) {
    setInterval(cleanupOldLogs, 60 * 60 * 1000);
    cleanupIntervalStarted = true;
  }

  isFileLoggerInitialized = true;
}

/**
 * Write log entry to file
 */
function writeToFile(entry: string): void {
  if (!isProduction) return;
  
  try {
    initializeFileLogger();
    rotateLogFile();
    
    if (currentLogStream) {
      const line = entry + '\n';
      currentLogStream.write(line);
      currentLogSize += Buffer.byteLength(line, 'utf-8');
    } else if (currentLogFile) {
      // Fallback if stream is missing but path is set
      const line = entry + '\n';
      fs.appendFileSync(currentLogFile, line, 'utf-8');
      currentLogSize += Buffer.byteLength(line, 'utf-8');
    }
  } catch (error) {
    // Don't use logger here to avoid infinite loop
    console.error('Failed to write to log file:', error);
  }
}

/**
 * Format log entry for file
 */
function formatFileEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
  error?: Error
): string {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
    error: error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : undefined,
  };
  
  return JSON.stringify(entry);
}

/**
 * File logger interface
 */
export interface FileLogger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  flush(): void;
}

/**
 * Create file logger instance
 */
function createFileLogger(): FileLogger {
  return {
    info: (message: string, context?: LogContext) => {
      const entry = formatFileEntry('info', message, context);
      writeToFile(entry);
    },
    
    warn: (message: string, context?: LogContext) => {
      const entry = formatFileEntry('warn', message, context);
      writeToFile(entry);
    },
    
    error: (message: string, error?: Error, context?: LogContext) => {
      const entry = formatFileEntry('error', message, context, error);
      writeToFile(entry);
    },
    
    debug: (message: string, context?: LogContext) => {
      const entry = formatFileEntry('debug', message, context);
      writeToFile(entry);
    },
    
    flush: () => {
      // Force rotation check on flush
      rotateLogFile();
    },
  };
}

// Export singleton instance
export const fileLogger = createFileLogger();

/**
 * Combined logger that writes to both console and file
 */
export const combinedLogger = {
  info: (message: string, context?: LogContext) => {
    logger.info(message, context);
    fileLogger.info(message, context);
  },
  
  warn: (message: string, context?: LogContext) => {
    logger.warn(message, context);
    fileLogger.warn(message, context);
  },
  
  error: (message: string, error?: Error, context?: LogContext) => {
    logger.error(message, error, context);
    fileLogger.error(message, error, context);
  },
  
  debug: (message: string, context?: LogContext) => {
    logger.debug(message, context);
    fileLogger.debug(message, context);
  },
  
  child: (context: LogContext) => {
    const _childLogger = logger.child(context);
    return {
      info: (msg: string, ctx?: LogContext) => combinedLogger.info(msg, { ...context, ...ctx }),
      warn: (msg: string, ctx?: LogContext) => combinedLogger.warn(msg, { ...context, ...ctx }),
      error: (msg: string, err?: Error, ctx?: LogContext) => combinedLogger.error(msg, err, { ...context, ...ctx }),
      debug: (msg: string, ctx?: LogContext) => combinedLogger.debug(msg, { ...context, ...ctx }),
    };
  },
  
  withRequestId: (requestId: string) => {
    return combinedLogger.child({ requestId });
  },
  
  withUserId: (userId: string) => {
    return combinedLogger.child({ userId });
  },
};

export default fileLogger;
