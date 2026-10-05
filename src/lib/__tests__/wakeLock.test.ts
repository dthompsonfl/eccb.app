import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock navigator.wakeLock
const mockWakeLock = {
  request: vi.fn(),
};

const mockSentinel = {
  released: false,
  type: 'screen',
  release: vi.fn(),
};

// Store original navigator
const originalNavigator = global.navigator;

describe('wakeLock utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSentinel.released = false;
    
    // Reset modules to test fresh imports
    vi.resetModules();
  });

  afterEach(() => {
    // Restore navigator
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    });
  });

  describe('isWakeLockSupported', () => {
    it('returns true when Wake Lock API is available', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { isWakeLockSupported } = await import('../wakeLock');
      expect(isWakeLockSupported()).toBe(true);
    });

    it('returns false when Wake Lock API is not available', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {},
        writable: true,
      });

      const { isWakeLockSupported } = await import('../wakeLock');
      expect(isWakeLockSupported()).toBe(false);
    });

    it('returns false when navigator is undefined (SSR)', async () => {
      Object.defineProperty(global, 'navigator', {
        value: undefined,
        writable: true,
      });

      const { isWakeLockSupported } = await import('../wakeLock');
      expect(isWakeLockSupported()).toBe(false);
    });
  });

  describe('acquireWakeLock', () => {
    it('acquires wake lock successfully', async () => {
      mockWakeLock.request.mockResolvedValueOnce(mockSentinel);
      
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { acquireWakeLock } = await import('../wakeLock');
      const result = await acquireWakeLock();

      expect(mockWakeLock.request).toHaveBeenCalledWith('screen');
      expect(result).toBe(mockSentinel);
    });

    it('returns null and starts fallback when Wake Lock API is not available', async () => {
      const fallbackCallback = vi.fn();
      
      Object.defineProperty(global, 'navigator', {
        value: {},
        writable: true,
      });

      const { acquireWakeLock } = await import('../wakeLock');
      const result = await acquireWakeLock(fallbackCallback);

      expect(result).toBeNull();
      expect(fallbackCallback).toHaveBeenCalled();
    });

    it('calls fallback callback when wake lock request fails', async () => {
      mockWakeLock.request.mockRejectedValueOnce(new Error('Not allowed'));
      
      const fallbackCallback = vi.fn();
      
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { acquireWakeLock } = await import('../wakeLock');
      const result = await acquireWakeLock(fallbackCallback);

      expect(result).toBeNull();
      expect(fallbackCallback).toHaveBeenCalled();
    });
  });

  describe('releaseWakeLock', () => {
    it('releases wake lock successfully', async () => {
      mockWakeLock.request.mockResolvedValueOnce(mockSentinel);
      mockSentinel.release.mockResolvedValueOnce(undefined);
      
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { acquireWakeLock, releaseWakeLock } = await import('../wakeLock');
      await acquireWakeLock();
      const result = await releaseWakeLock();

      expect(mockSentinel.release).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('returns true when no wake lock is held', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { releaseWakeLock } = await import('../wakeLock');
      const result = await releaseWakeLock();

      expect(result).toBe(true);
    });
  });

  describe('isWakeLockActive', () => {
    it('returns true when wake lock is active', async () => {
      mockWakeLock.request.mockResolvedValueOnce(mockSentinel);
      
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { acquireWakeLock, isWakeLockActive } = await import('../wakeLock');
      await acquireWakeLock();
      
      expect(isWakeLockActive()).toBe(true);
    });

    it('returns false when no wake lock is held', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { isWakeLockActive } = await import('../wakeLock');
      expect(isWakeLockActive()).toBe(false);
    });

    it('does NOT report active when only the best-effort fallback is running', async () => {
      // Regression guard: the fallback cannot prevent device sleep, so
      // reporting a guaranteed wake lock here would be a false promise.
      // Callers must be able to distinguish degraded mode via
      // isUsingFallbackWakeLock() instead.
      Object.defineProperty(global, 'navigator', {
        value: {}, // no native Wake Lock API
        writable: true,
      });

      const { acquireWakeLock, isWakeLockActive, isUsingFallbackWakeLock } =
        await import('../wakeLock');
      await acquireWakeLock();

      expect(isUsingFallbackWakeLock()).toBe(true);
      expect(isWakeLockActive()).toBe(false);
    });
  });

  describe('isUsingFallbackWakeLock', () => {
    it('returns true when using fallback', async () => {
      Object.defineProperty(global, 'navigator', {
        value: {},
        writable: true,
      });

      const { acquireWakeLock, isUsingFallbackWakeLock } = await import('../wakeLock');
      await acquireWakeLock();
      
      expect(isUsingFallbackWakeLock()).toBe(true);
    });

    it('returns false when using native wake lock', async () => {
      mockWakeLock.request.mockResolvedValueOnce(mockSentinel);
      
      Object.defineProperty(global, 'navigator', {
        value: {
          wakeLock: mockWakeLock,
        },
        writable: true,
      });

      const { acquireWakeLock, isUsingFallbackWakeLock } = await import('../wakeLock');
      await acquireWakeLock();
      
      expect(isUsingFallbackWakeLock()).toBe(false);
    });
  });

  describe('fullscreen functions', () => {
    it('requestFullscreen returns true when successful', async () => {
      const mockRequestFullscreen = vi.fn().mockResolvedValueOnce(undefined);
      
      Object.defineProperty(global, 'document', {
        value: {
          fullscreenElement: null,
          documentElement: {
            requestFullscreen: mockRequestFullscreen,
          },
        },
        writable: true,
      });

      const { requestFullscreen } = await import('../wakeLock');
      const result = await requestFullscreen();

      expect(mockRequestFullscreen).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('exitFullscreen returns true when successful', async () => {
      const mockExitFullscreen = vi.fn().mockResolvedValueOnce(undefined);
      
      Object.defineProperty(global, 'document', {
        value: {
          fullscreenElement: {},
          exitFullscreen: mockExitFullscreen,
        },
        writable: true,
      });

      const { exitFullscreen } = await import('../wakeLock');
      const result = await exitFullscreen();

      expect(mockExitFullscreen).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('isFullscreen returns true when in fullscreen', async () => {
      Object.defineProperty(global, 'document', {
        value: {
          fullscreenElement: {},
        },
        writable: true,
      });

      const { isFullscreen } = await import('../wakeLock');
      expect(isFullscreen()).toBe(true);
    });

    it('isFullscreen returns false when not in fullscreen', async () => {
      Object.defineProperty(global, 'document', {
        value: {
          fullscreenElement: null,
        },
        writable: true,
      });

      const { isFullscreen } = await import('../wakeLock');
      expect(isFullscreen()).toBe(false);
    });
  });
});
