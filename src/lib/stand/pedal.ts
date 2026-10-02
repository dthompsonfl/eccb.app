/**
 * Bluetooth foot-pedal support for the Digital Music Stand.
 *
 * Reuses the SAME `MidiAction` vocabulary as `MidiHandler`, so a Bluetooth pedal
 * and a MIDI pedal drive identical stand behaviour. There is deliberately no
 * parallel action model: a musician who learns one works with the other.
 *
 * The translation from raw pedal bytes to an action is pure and lives here, so
 * it can be tested without a Bluetooth radio. GATT connection handling lives in
 * the component.
 *
 * AirTurn BT-200 / PageFlip pedals present as a BLE peripheral and notify a
 * characteristic when a pedal is pressed. The payloads vary by model and mode
 * (HID vs. the older "single byte" mode), so decoding is deliberately tolerant:
 * it looks for a recognisable pattern rather than insisting on one layout.
 */

import type { MidiAction } from '@/components/member/stand/MidiHandler';

/** Every stand action a pedal can trigger. Reused from the MIDI vocabulary. */
export const PEDAL_ACTIONS: readonly MidiAction[] = [
  'nextPageOrPiece',
  'prevPageOrPiece',
  'toggleGigMode',
  'toggleNightMode',
  'toggleMetronome',
  'toggleTuner',
  'toggleAudioPlayer',
  'togglePitchPipe',
];

/** Human-readable labels, reused for both the pedal and MIDI mapping UIs. */
export const PEDAL_ACTION_LABELS: Record<MidiAction, string> = {
  nextPageOrPiece: 'Next page / piece',
  prevPageOrPiece: 'Previous page / piece',
  toggleGigMode: 'Toggle gig mode',
  toggleNightMode: 'Toggle night mode',
  toggleMetronome: 'Toggle metronome',
  toggleTuner: 'Toggle tuner',
  toggleAudioPlayer: 'Toggle audio player',
  togglePitchPipe: 'Toggle pitch pipe',
};

/** Logical pedal, independent of how many switches a device has. */
export type Pedal = 'left' | 'right' | 'middle' | 'aux';

export const PEDALS: readonly Pedal[] = ['left', 'right', 'middle', 'aux'];

export const PEDAL_LABELS: Record<Pedal, string> = {
  left: 'Left pedal',
  right: 'Right pedal',
  middle: 'Middle pedal',
  aux: 'Aux pedal',
};

/** Pedal → action. User-editable and persisted per user. */
export type PedalMapping = Record<Pedal, MidiAction | null>;

/**
 * Sensible defaults for a two-pedal AirTurn-style device: left goes back, right
 * goes forward. Middle/aux are unassigned so an accidental press does nothing.
 */
export const DEFAULT_PEDAL_MAPPING: PedalMapping = {
  left: 'prevPageOrPiece',
  right: 'nextPageOrPiece',
  middle: null,
  aux: null,
};

// =============================================================================
// Decoding
// =============================================================================

/**
 * Decode a raw BLE notification into a pedal.
 *
 * AirTurn-family pedals use two incompatible encodings and a single byte can be
 * ambiguous between them: legacy mode sends 1..4 naming the pedal, while HID mode
 * sends a bitmask where 0x04 means "middle" and 0x08 means "aux". Values 1 and 2
 * are identical in both, so no decoder can distinguish them — and does not need
 * to, because both mean left and right.
 *
 * Precedence is therefore explicit: a single byte of 1..4 is legacy mode; any
 * other single byte, and any multi-byte notification, is a bitmask. This is a
 * deliberate, documented trade-off rather than an accident.
 *
 * Returns null when the data carries no recognisable pedal press (an all-zero
 * keepalive, or a value outside both encodings).
 */
export function decodePedalEvent(data: ArrayBuffer | Uint8Array | undefined | null): Pedal | null {
  if (!data) return null;

  const bytes =
    data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  if (bytes.length === 0) return null;

  // An all-zero payload is a keepalive / idle notification, not a press.
  const isAllZero = bytes.every((b) => b === 0);
  if (isAllZero) return null;

  // Common AirTurn "single byte" mode: the value itself names the pedal.
  // 1 = left/prev, 2 = right/next, 3 = middle, 4 = aux.
  const legacy = decodeLegacyByte(bytes);
  if (legacy) return legacy;

  // HID-style: a bitmask of pressed switches in the last non-zero byte.
  return decodeBitmask(bytes);
}

function decodeLegacyByte(bytes: Uint8Array): Pedal | null {
  // Single-byte mode is exactly one byte with a value of 1..4.
  if (bytes.length === 1) {
    switch (bytes[0]) {
      case 1:
        return 'left';
      case 2:
        return 'right';
      case 3:
        return 'middle';
      case 4:
        return 'aux';
      default:
        return null;
    }
  }
  return null;
}

function decodeBitmask(bytes: Uint8Array): Pedal | null {
  // Only the low nibble names pedals. A byte with other bits set is not a
  // pedal report we understand, and guessing would fire the wrong page turn
  // mid-performance.
  const PEDAL_BITS = 0x0f;

  // Scan from the end: the most recent state byte is the informative one.
  for (let i = bytes.length - 1; i >= 0; i--) {
    const value = bytes[i];
    if (value === 0) continue;

    if ((value & ~PEDAL_BITS) !== 0) return null;

    // Bitmask layout: bit0 left, bit1 right, bit2 middle, bit3 aux.
    if ((value & 0x01) !== 0) return 'left';
    if ((value & 0x02) !== 0) return 'right';
    if ((value & 0x04) !== 0) return 'middle';
    if ((value & 0x08) !== 0) return 'aux';

    return null;
  }
  return null;
}

/** The stand action a pedal press maps to, or null if unassigned. */
export function actionForPedal(
  pedal: Pedal | null,
  mapping: PedalMapping,
): MidiAction | null {
  if (!pedal) return null;
  return mapping[pedal] ?? null;
}

/** Decode raw bytes straight through the mapping to an action. */
export function actionFromBytes(
  data: ArrayBuffer | Uint8Array | undefined | null,
  mapping: PedalMapping,
): MidiAction | null {
  return actionForPedal(decodePedalEvent(data), mapping);
}

// =============================================================================
// Support detection
// =============================================================================

/**
 * The subset of `navigator` this module reads.
 *
 * `Navigator.bluetooth` is not in the TypeScript DOM lib (Web Bluetooth is
 * Chromium-only and still being standardised), so it is declared structurally
 * here rather than cast to `any` at each call site.
 */
export interface BluetoothCapableNavigator {
  bluetooth?: unknown;
}

/**
 * Whether Web Bluetooth can be used here.
 *
 * Web Bluetooth is Chromium-only and requires a secure context, so Safari and
 * Firefox get a clear "not supported" state rather than a silent failure.
 */
export function isBluetoothPedalSupported(
  nav: BluetoothCapableNavigator | undefined | null = typeof navigator !== 'undefined'
    ? (navigator as BluetoothCapableNavigator)
    : null,
  win: { isSecureContext?: boolean } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): boolean {
  if (!nav || !('bluetooth' in nav) || !nav.bluetooth) return false;
  // localhost is a secure context; an insecure origin cannot use the API.
  if (win && win.isSecureContext === false) return false;
  return true;
}

/** Why Bluetooth is unavailable, for a user-facing message. */
export function bluetoothUnavailableReason(
  nav: BluetoothCapableNavigator | undefined | null = typeof navigator !== 'undefined'
    ? (navigator as BluetoothCapableNavigator)
    : null,
  win: { isSecureContext?: boolean } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): string | null {
  if (isBluetoothPedalSupported(nav, win)) return null;
  if (win && win.isSecureContext === false) {
    return 'Bluetooth foot pedals need a secure (HTTPS) connection.';
  }
  return 'This browser does not support Bluetooth foot pedals. Chrome or Edge on desktop or Android support them.';
}

// =============================================================================
// Mapping persistence
// =============================================================================

function isMidiAction(value: unknown): value is MidiAction {
  return typeof value === 'string' && (PEDAL_ACTIONS as readonly string[]).includes(value);
}

/**
 * Load a persisted mapping, repairing anything unrecognised.
 *
 * A stored value that is no longer a valid action is dropped to null rather than
 * trusted, so a removed action cannot be dispatched at runtime.
 */
export function loadPedalMapping(stored: unknown): PedalMapping {
  const mapping: PedalMapping = { ...DEFAULT_PEDAL_MAPPING };
  if (!stored || typeof stored !== 'object') return mapping;

  const record = stored as Record<string, unknown>;
  for (const pedal of PEDALS) {
    const value = record[pedal];
    if (value === null) {
      mapping[pedal] = null;
    } else if (isMidiAction(value)) {
      mapping[pedal] = value;
    }
    // Anything else keeps the default rather than becoming a bad action.
  }
  return mapping;
}

/** Whether two mappings are equal, so callers can skip redundant saves. */
export function pedalMappingsEqual(a: PedalMapping, b: PedalMapping): boolean {
  return PEDALS.every((pedal) => (a[pedal] ?? null) === (b[pedal] ?? null));
}

// =============================================================================
// Connection state
// =============================================================================

export type PedalConnectionStatus =
  | 'unsupported'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * Derive the display status.
 *
 * Kept pure so a stale "connected" indicator — the failure mode when a pedal
 * walks out of range mid-performance — is provably impossible.
 */
export function deriveConnectionStatus(args: {
  supported: boolean;
  connecting: boolean;
  connected: boolean;
  error: boolean;
}): PedalConnectionStatus {
  if (!args.supported) return 'unsupported';
  if (args.error) return 'error';
  if (args.connected) return 'connected';
  if (args.connecting) return 'connecting';
  return 'disconnected';
}

/** A short, screen-reader friendly description of the current status. */
export function describeConnectionStatus(
  status: PedalConnectionStatus,
  deviceName?: string | null,
): string {
  switch (status) {
    case 'unsupported':
      return bluetoothUnavailableReason() ?? 'Bluetooth foot pedals are not available.';
    case 'connecting':
      return 'Connecting to Bluetooth foot pedal…';
    case 'connected':
      return deviceName
        ? `Bluetooth foot pedal connected: ${deviceName}.`
        : 'Bluetooth foot pedal connected.';
    case 'error':
      return 'Bluetooth foot pedal connection failed. Please check the device and try again.';
    case 'disconnected':
    default:
      return 'Bluetooth foot pedal not connected.';
  }
}

/** True when the browser rejecting the chooser means "user cancelled". */
export function isUserCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'NotFoundError' || name === 'AbortError';
}
