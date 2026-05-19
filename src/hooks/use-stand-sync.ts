import { useEffect, useRef, useCallback, useState } from 'react';
import { useStandStore } from '@/store/standStore';
import { io as socketIoClient, type Socket } from 'socket.io-client';
import { logger } from '@/lib/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface StandRosterMember {
  userId: string;
  name: string;
  section?: string;
  joinedAt: string;
}

export interface StandState {
  eventId: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
  lastUpdated?: string;
}

export type StandMessageType =
  | 'presence'
  | 'command'
  | 'mode'
  | 'annotation'
  | 'state'
  | 'roster';

export interface PresenceMessage {
  type: 'presence';
  userId: string;
  name: string;
  section?: string;
  status: 'joined' | 'left';
}

export interface CommandMessage {
  type: 'command';
  action: 'setPage' | 'setPiece' | 'toggleNightMode';
  page?: number;
  pieceIndex?: number;
  value?: boolean;
}

export interface ModeMessage {
  type: 'mode';
  name: string;
  value: unknown;
}

export interface AnnotationMessage {
  type: 'annotation';
  data: Record<string, unknown>;
}

export interface StateMessage {
  type: 'state';
  eventId: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
}

export interface RosterMessage {
  type: 'roster';
  members: StandRosterMember[];
}

export type StandMessage =
  | PresenceMessage
  | CommandMessage
  | ModeMessage
  | AnnotationMessage
  | StateMessage
  | RosterMessage;

export interface UseStandSyncOptions {
  eventId: string;
  userId: string;
  musicId?: string;
  onStateChange?: (state: StandState) => void;
  onRosterChange?: (roster: StandRosterMember[]) => void;
  onPresenceChange?: (presence: PresenceMessage) => void;
  onCommand?: (command: CommandMessage) => void;
  onModeChange?: (mode: ModeMessage) => void;
  onAnnotation?: (annotation: AnnotationMessage) => void;
  onError?: (error: Error) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  pollingInterval?: number;
  /** Set true only if a Socket.IO server is running. Defaults to false (polling). */
  realtimeEnabled?: boolean;
}

export interface UseStandSyncReturn {
  isConnected: boolean;
  connectionError: Error | null;
  roster: StandRosterMember[];
  currentState: StandState | null;
  sendCommand: (command: Omit<CommandMessage, 'type'>) => void;
  sendMode: (name: string, value: unknown) => void;
  sendAnnotation: (data: Record<string, unknown>) => void;
  reconnect: () => void;
  disconnect: () => void;
  isPollingFallback: boolean;
}

interface PollingSyncResponse {
  eventId?: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
  lastSyncAt?: string;
  activeUserList?: Array<{ userId: string; name: string; section?: string }>;
  recentAnnotations?: Record<string, unknown>[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_RECONNECT_INTERVAL = 3000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_POLLING_INTERVAL = 5000; // 5 seconds for polling fallback
const SOCKET_PATH = '/api/stand/socket';
/** Cap on exponential back-off delay (30 s). */
const MAX_BACKOFF_MS = 30_000;
/** Heartbeat interval matching the server expectation (30 s). */
const CLIENT_HEARTBEAT_INTERVAL_MS = 30_000;

// =============================================================================
// HELPERS
// =============================================================================

function isWebSocketAvailable(): boolean {
  return typeof WebSocket !== 'undefined' || typeof window !== 'undefined';
}

function canUseSocketIO(): boolean {
  return typeof window !== 'undefined';
}

function normalizeRosterMembers(
  activeUserList: PollingSyncResponse['activeUserList']
): StandRosterMember[] {
  if (!Array.isArray(activeUserList)) return [];
  return activeUserList.map((u) => ({
    userId: u.userId,
    name: u.name,
    section: u.section,
    joinedAt: new Date().toISOString(),
  }));
}

// =============================================================================
// HOOK
// =============================================================================

export function useStandSync({
  eventId,
  userId,
  musicId,
  onStateChange,
  onRosterChange,
  onPresenceChange,
  onCommand,
  onModeChange,
  onAnnotation,
  onError,
  reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
  pollingInterval = DEFAULT_POLLING_INTERVAL,
  realtimeEnabled = false,
}: UseStandSyncOptions): UseStandSyncReturn {
  const socketRef = useRef<Socket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const seenAnnotationVersionsRef = useRef<Map<string, string>>(new Map());

  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const [roster, setRoster] = useState<StandRosterMember[]>([]);
  const [currentState, setCurrentState] = useState<StandState | null>(null);
  const [isPollingFallback, setIsPollingFallback] = useState(false);

  const connectRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});
  const fetchStateRef = useRef<() => Promise<void>>(async () => {});
  const sendPresenceRef = useRef<(status: 'joined' | 'left') => Promise<void>>(async () => {});

  const sendPresence = useCallback(
    async (status: 'joined' | 'left') => {
      try {
        await fetch('/api/stand/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId,
            presence: { type: 'presence', status },
          }),
        });
      } catch (err) {
        logger.error('[useStandSync] Failed to send presence:', err as Error);
      }
    },
    [eventId]
  );

  const fetchState = useCallback(async () => {
    try {
      const params = new URLSearchParams({ eventId });
      if (musicId) {
        params.set('musicId', musicId);
      }

      const response = await fetch(`/api/stand/sync?${params.toString()}`);
      if (response.ok) {
        const data = (await response.json()) as PollingSyncResponse;

        const state: StandState = {
          eventId: data.eventId ?? eventId,
          currentPage: data.currentPage,
          currentPieceIndex: data.currentPieceIndex,
          nightMode: data.nightMode,
          lastUpdated: data.lastSyncAt,
        };
        setCurrentState(state);
        onStateChange?.(state);

        const rosterMembers = normalizeRosterMembers(data.activeUserList);
        setRoster(rosterMembers);
        onRosterChange?.(rosterMembers);
        useStandStore.getState().setRoster(rosterMembers);

        if (Array.isArray(data.recentAnnotations)) {
          for (const annotation of data.recentAnnotations) {
            const annotationId =
              typeof annotation.id === 'string' ? annotation.id : null;
            const updatedAt =
              typeof annotation.updatedAt === 'string'
                ? annotation.updatedAt
                : typeof annotation.createdAt === 'string'
                  ? annotation.createdAt
                  : '';
            if (!annotationId) continue;

            const versionKey = `${annotationId}:${updatedAt}`;
            if (seenAnnotationVersionsRef.current.get(annotationId) === versionKey) {
              continue;
            }

            seenAnnotationVersionsRef.current.set(annotationId, versionKey);
            onAnnotation?.({
              type: 'annotation',
              data: annotation,
            });
          }
        }

        setIsConnected(true);
        setConnectionError(null);
      }
    } catch (error) {
      logger.error('[useStandSync] Polling error:', error as Error);
    }
  }, [eventId, musicId, onAnnotation, onRosterChange, onStateChange]);

  fetchStateRef.current = fetchState;
  sendPresenceRef.current = sendPresence;

  const startPollingFallback = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    setIsPollingFallback(true);
    logger.debug('[useStandSync] Starting polling fallback - WebSocket unavailable');

    const poll = () => {
      void sendPresenceRef.current('joined').finally(() => {
        void fetchStateRef.current();
      });
    };

    poll();
    pollingIntervalRef.current = setInterval(poll, pollingInterval);
  }, [pollingInterval]);

  const stopPollingFallback = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setIsPollingFallback(false);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectAttemptsRef.current += 1;
    const delay = Math.min(
      reconnectInterval * Math.pow(2, reconnectAttemptsRef.current - 1),
      MAX_BACKOFF_MS,
    );
    logger.debug(
      `[useStandSync] Scheduling reconnect attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts} in ${delay}ms`
    );

    reconnectTimeoutRef.current = setTimeout(() => {
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        connectRef.current();
      } else {
        setConnectionError(new Error('Max reconnection attempts reached'));
        startPollingFallback();
      }
    }, delay);
  }, [reconnectInterval, maxReconnectAttempts, startPollingFallback]);

  const connect = useCallback(() => {
    if (!isWebSocketAvailable() || !canUseSocketIO()) {
      logger.warn('[useStandSync] WebSocket not available, using polling fallback');
      startPollingFallback();
      return;
    }

    if (socketRef.current?.connected) {
      return;
    }

    const socketUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    try {
      const socket = socketIoClient(socketUrl as string, {
        path: SOCKET_PATH,
        query: {
          eventId,
          userId,
        },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 10000,
      });

      socket.on('connect', () => {
        logger.debug('[useStandSync] Connected to stand sync server');
        setIsConnected(true);
        setConnectionError(null);
        reconnectAttemptsRef.current = 0;
        stopPollingFallback();

        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = setInterval(() => {
          socketRef.current?.emit('message', { type: 'heartbeat' });
        }, CLIENT_HEARTBEAT_INTERVAL_MS);
      });

      socket.on('disconnect', (reason) => {
        logger.debug(`[useStandSync] Disconnected: ${reason}`);
        setIsConnected(false);

        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        if (reason !== 'io client disconnect' && reconnectAttemptsRef.current < maxReconnectAttempts) {
          scheduleReconnectRef.current();
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          startPollingFallback();
        }
      });

      socket.on('connect_error', (error) => {
        logger.error('[useStandSync] Connection error:', error);
        setConnectionError(new Error(error.message));
        setIsConnected(false);

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          scheduleReconnectRef.current();
        } else {
          startPollingFallback();
        }
      });

      socket.on('error', (error: { message: string }) => {
        logger.error('[useStandSync] Socket error:', new Error(error.message));
        onError?.(new Error(error.message));
      });

      socket.on('state', (state: StateMessage) => {
        setCurrentState(state);
        onStateChange?.(state);
      });

      socket.on('roster', (data: RosterMessage) => {
        setRoster(data.members);
        onRosterChange?.(data.members);
        useStandStore.getState().setRoster(data.members);
      });

      socket.on('message', (message: StandMessage) => {
        switch (message.type) {
          case 'presence':
            if (message.status === 'joined') {
              setRoster((prev) => {
                if (prev.some((m) => m.userId === message.userId)) {
                  return prev;
                }
                const newList = [
                  ...prev,
                  {
                    userId: message.userId,
                    name: message.name,
                    section: message.section,
                    joinedAt: new Date().toISOString(),
                  },
                ];
                useStandStore.getState().addRosterEntry({
                  userId: message.userId,
                  name: message.name,
                  section: message.section,
                  joinedAt: new Date().toISOString(),
                });
                return newList;
              });
            } else {
              setRoster((prev) => prev.filter((m) => m.userId !== message.userId));
              useStandStore.getState().removeRosterEntry(message.userId);
            }
            onPresenceChange?.(message);
            break;

          case 'command':
            onCommand?.(message);
            break;

          case 'mode':
            onModeChange?.(message);
            break;

          case 'annotation':
            onAnnotation?.(message);
            break;
        }
      });

      socketRef.current = socket;
    } catch (error) {
      logger.error('[useStandSync] Failed to create socket:', error as Error);
      setConnectionError(error as Error);
      startPollingFallback();
    }
  }, [eventId, userId, onStateChange, onRosterChange, onPresenceChange, onCommand, onModeChange, onAnnotation, onError, maxReconnectAttempts, startPollingFallback, stopPollingFallback]);

  connectRef.current = connect;
  scheduleReconnectRef.current = scheduleReconnect;

  const sendCommand = useCallback(
    (command: Omit<CommandMessage, 'type'>) => {
      if (isPollingFallback) {
        fetch('/api/stand/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId, command: { type: 'command', ...command } }),
        }).catch((err) => {
          logger.error('[useStandSync] Failed to send command:', err as Error);
        });
        return;
      }

      if (!socketRef.current?.connected) {
        logger.warn('[useStandSync] Cannot send command: not connected');
        return;
      }

      socketRef.current.emit('message', {
        type: 'command',
        ...command,
      });
    },
    [eventId, isPollingFallback]
  );

  const sendMode = useCallback(
    (name: string, value: unknown) => {
      if (isPollingFallback) {
        const payload =
          name === 'nightMode' && typeof value === 'boolean'
            ? { eventId, nightMode: value }
            : { eventId, mode: { type: 'mode', name, value } };

        fetch('/api/stand/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch((err) => {
          logger.error('[useStandSync] Failed to send mode:', err as Error);
        });
        return;
      }

      if (!socketRef.current?.connected) {
        logger.warn('[useStandSync] Cannot send mode: not connected');
        return;
      }

      socketRef.current.emit('message', {
        type: 'mode',
        name,
        value,
      });
    },
    [eventId, isPollingFallback]
  );

  const sendAnnotation = useCallback(
    (data: Record<string, unknown>) => {
      if (isPollingFallback) {
        return;
      }

      if (!socketRef.current?.connected) {
        logger.warn('[useStandSync] Cannot send annotation: not connected');
        return;
      }

      socketRef.current.emit('message', {
        type: 'annotation',
        data,
      });
    },
    [isPollingFallback]
  );

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    stopPollingFallback();
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    connect();
  }, [connect, stopPollingFallback]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    stopPollingFallback();
    reconnectAttemptsRef.current = maxReconnectAttempts;

    if (socketRef.current) {
      socketRef.current.emit('message', {
        type: 'presence',
        userId,
        name: '',
        status: 'left',
      });
      socketRef.current.disconnect();
      socketRef.current = null;
    } else {
      void sendPresenceRef.current('left');
    }

    setIsConnected(false);
    setRoster([]);
    setCurrentState(null);
  }, [userId, maxReconnectAttempts, stopPollingFallback]);

  useEffect(() => {
    if (realtimeEnabled) {
      connect();
    } else {
      startPollingFallback();
    }

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      stopPollingFallback();

      if (socketRef.current) {
        socketRef.current.emit('message', {
          type: 'presence',
          userId,
          name: '',
          status: 'left',
        });
        socketRef.current.disconnect();
        socketRef.current = null;
      } else {
        void sendPresenceRef.current('left');
      }

      setIsConnected(false);
    };
  }, [connect, realtimeEnabled, startPollingFallback, stopPollingFallback, userId]);

  return {
    isConnected,
    connectionError,
    roster,
    currentState,
    sendCommand,
    sendMode,
    sendAnnotation,
    reconnect,
    disconnect,
    isPollingFallback,
  };
}
