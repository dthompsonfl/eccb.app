'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStandStore } from '@/store/standStore';
import { cn } from '@/lib/utils';
import type { MidiAction } from './MidiHandler';
import {
  DEFAULT_PEDAL_MAPPING,
  PEDAL_ACTION_LABELS,
  PEDAL_LABELS,
  PEDALS,
  actionFromBytes,
  bluetoothUnavailableReason,
  deriveConnectionStatus,
  describeConnectionStatus,
  isBluetoothPedalSupported,
  isUserCancellation,
  loadPedalMapping,
  pedalMappingsEqual,
  type Pedal,
  type PedalMapping,
} from '@/lib/stand/pedal';

const PEDAL_STORAGE_KEY = 'eccb.pedal-mapping';

interface BluetoothHandlerProps {
  className?: string;
}

/** Service UUIDs exposed by AirTurn-family BLE foot pedals. */
const PEDAL_SERVICE_UUIDS = [
  '0000ffe0-0000-1000-8000-00805f9b34fb', // AirTurn BT-200 vendor service
  '0000fff0-0000-1000-8000-00805f9b34fb', // common HID-over-GATT service
  '00001800-0000-1000-8000-00805f9b34fb', // generic HID service
];

const PEDAL_NOTIFY_CHARACTERISTIC_UUIDS = [
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000fff1-0000-1000-8000-00805f9b34fb',
  '00002a37-0000-1000-8000-00805f9b34fb', // HID input report
];

/**
 * BluetoothHandler - Web Bluetooth foot pedal support for the stand.
 *
 * Drives the SAME actions as MidiHandler: a musician who learns the MIDI pedal
 * already knows this one. The translation from raw BLE bytes to an action lives
 * in `@/lib/stand/pedal` so it is testable without a radio; this component owns
 * the GATT connection lifecycle.
 *
 * Accessibility: every control is keyboard reachable and labelled, and the
 * connection state is announced through a polite live region. Status is never
 * conveyed by colour alone.
 */
export function BluetoothHandler({ className }: BluetoothHandlerProps) {
  const store = useStandStore();
  const [mapping, setMapping] = useState<PedalMapping>(DEFAULT_PEDAL_MAPPING);
  const [status, setStatus] = useState<ReturnType<typeof deriveConnectionStatus>>(() =>
    deriveConnectionStatus({
      supported: isBluetoothPedalSupported(),
      connecting: false,
      connected: false,
      error: false,
    }),
  );
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [showMapping, setShowMapping] = useState(false);

  const supported = isBluetoothPedalSupported();
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;

  const deviceRef = useRef<{ gatt?: { disconnect?: () => void } } | null>(null);

  // ── Load persisted mapping ───────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PEDAL_STORAGE_KEY);
      if (stored) setMapping(loadPedalMapping(JSON.parse(stored)));
    } catch {
      // A corrupt or unavailable store must not break the stand.
      setMapping(DEFAULT_PEDAL_MAPPING);
    }
  }, []);

  const updateMapping = useCallback((pedal: Pedal, action: MidiAction | null) => {
    setMapping((prev) => {
      const next = { ...prev, [pedal]: action };
      if (pedalMappingsEqual(prev, next)) return prev;
      try {
        window.localStorage.setItem(PEDAL_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Persisting is best-effort; the in-session mapping still applies.
      }
      return next;
    });
  }, []);

  /** Perform a stand action. Deliberately the same vocabulary as MidiHandler. */
  const performAction = useCallback(
    (action: MidiAction) => {
      switch (action) {
        case 'nextPageOrPiece':
          store.nextPageOrPiece();
          break;
        case 'prevPageOrPiece':
          store.prevPageOrPiece();
          break;
        case 'toggleGigMode':
          store.toggleGigMode();
          break;
        case 'toggleNightMode':
          store.toggleNightMode();
          break;
        case 'toggleMetronome':
          store.toggleMetronome();
          break;
        case 'toggleTuner':
          store.toggleTuner();
          break;
        case 'toggleAudioPlayer':
          store.toggleAudioPlayer();
          break;
        case 'togglePitchPipe':
          store.togglePitchPipe();
          break;
        default:
          break;
      }
    },
    [store],
  );

  const handleDisconnect = useCallback(() => {
    // Explicitly clears connected state so the UI can never show a stale
    // "connected" after the pedal walks out of range.
    setStatus('disconnected');
    setDeviceName(null);
    deviceRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    if (!supported) {
      setStatus('unsupported');
      return;
    }

    setStatus('connecting');

    interface BtCharacteristic {
      startNotifications: () => Promise<unknown>;
      addEventListener: (type: string, handler: (event: Event) => void) => void;
      removeEventListener: (type: string, handler: (event: Event) => void) => void;
    }
    interface BtServer {
      getPrimaryService: (uuid: string) => Promise<{
        getCharacteristic: (uuid: string) => Promise<BtCharacteristic>;
      }>;
    }
    interface BtDevice {
      name?: string;
      gatt?: {
        connect: () => Promise<BtServer>;
        disconnect?: () => void;
        addEventListener?: (type: string, handler: () => void) => void;
      };
    }

    try {
      const bluetooth = (
        navigator as unknown as {
          bluetooth?: {
            requestDevice: (options: unknown) => Promise<BtDevice>;
          };
        }
      ).bluetooth;

      if (!bluetooth) {
        setStatus('unsupported');
        return;
      }

      const device = await bluetooth.requestDevice({
        // Pedals do not always advertise a service list, so accept all and probe
        // the known characteristics on connect.
        acceptAllDevices: true,
        optionalServices: PEDAL_SERVICE_UUIDS,
      });

      const server = await device.gatt?.connect();
      if (!server) throw new Error('Could not connect to the pedal');

      deviceRef.current = device;
      device.gatt?.addEventListener?.('gattserverdisconnected', handleDisconnect);

      // Devices vary, so probe the known service/characteristic pairs.
      let characteristic: BtCharacteristic | null = null;
      for (const serviceUuid of PEDAL_SERVICE_UUIDS) {
        for (const charUuid of PEDAL_NOTIFY_CHARACTERISTIC_UUIDS) {
          try {
            const service = await server.getPrimaryService(serviceUuid);
            characteristic = await service.getCharacteristic(charUuid);
            break;
          } catch {
            // Try the next combination.
          }
        }
        if (characteristic) break;
      }

      if (!characteristic) throw new Error('Pedal characteristic not found');

      characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const value = (event.target as unknown as { value?: DataView })?.value;
        if (!value) return;
        const action = actionFromBytes(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          mappingRef.current,
        );
        if (action) performAction(action);
      });

      await characteristic.startNotifications();
      setDeviceName(device.name ?? 'Bluetooth pedal');
      setStatus('connected');
    } catch (err) {
      // A cancelled chooser is a normal outcome, not an error to shout about.
      if (isUserCancellation(err)) {
        setStatus('disconnected');
        return;
      }
      setStatus('error');
    }
  }, [supported, handleDisconnect, performAction]);

  // ── Disconnect on unmount so the radio is released ───────────────────────
  useEffect(() => {
    return () => {
      try {
        deviceRef.current?.gatt?.disconnect?.();
      } catch {
        // Already disconnected.
      }
      deviceRef.current = null;
    };
  }, []);

  // Nothing to offer when the platform cannot use Web Bluetooth: render the
  // explanation rather than a control that can never work.
  if (!supported || status === 'unsupported') {
    return (
      <div className={cn('bluetooth-handler text-sm', className)}>
        <div className="sr-only" role="status" aria-live="polite">
          {describeConnectionStatus('unsupported')}
        </div>
        <p className="p-2 text-xs text-muted-foreground" role="note">
          {bluetoothUnavailableReason()}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('bluetooth-handler text-sm', className)}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {describeConnectionStatus(status, deviceName)}
      </div>

      <div className="flex flex-wrap items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => (status === 'connected' ? handleDisconnect() : void connect())}
          disabled={status === 'connecting'}
          aria-label={
            status === 'connected'
              ? `Disconnect Bluetooth foot pedal ${deviceName ?? ''}`.trim()
              : 'Connect Bluetooth foot pedal'
          }
          className="min-h-[44px] px-3 border rounded disabled:opacity-50"
        >
          {status === 'connected'
            ? 'Disconnect pedal'
            : status === 'connecting'
              ? 'Connecting…'
              : 'Connect pedal'}
        </button>

        <button
          type="button"
          onClick={() => setShowMapping((v) => !v)}
          aria-expanded={showMapping}
          aria-controls="pedal-mapping"
          className="min-h-[44px] px-3 border rounded"
        >
          {showMapping ? 'Hide pedal mapping' : 'Pedal mapping'}
        </button>

        {/* Status is text, never colour alone. */}
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {deviceName ?? describeConnectionStatus(status)}
        </span>
      </div>

      {showMapping && (
        <div
          id="pedal-mapping"
          className="p-2 text-xs border-t"
          role="group"
          aria-label="Bluetooth pedal mapping"
        >
          <p className="mb-2 text-muted-foreground">
            Choose what each pedal does. Defaults: left goes back, right goes forward.
          </p>
          <ul className="flex flex-col gap-2">
            {PEDALS.map((pedal) => (
              <li key={pedal} className="flex items-center gap-2">
                <label htmlFor={`pedal-${pedal}`} className="min-w-[6rem]">
                  {PEDAL_LABELS[pedal]}
                </label>
                <select
                  id={`pedal-${pedal}`}
                  value={mapping[pedal] ?? ''}
                  onChange={(e) =>
                    updateMapping(pedal, (e.target.value || null) as MidiAction | null)
                  }
                  aria-label={`Action for ${PEDAL_LABELS[pedal]}`}
                  className="min-h-[44px] px-2 border rounded"
                >
                  <option value="">Do nothing</option>
                  {Object.entries(PEDAL_ACTION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

BluetoothHandler.displayName = 'BluetoothHandler';

export default BluetoothHandler;
