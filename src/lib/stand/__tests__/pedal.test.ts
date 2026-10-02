import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PEDAL_MAPPING,
  PEDAL_ACTIONS,
  actionForPedal,
  actionFromBytes,
  bluetoothUnavailableReason,
  decodePedalEvent,
  deriveConnectionStatus,
  describeConnectionStatus,
  isBluetoothPedalSupported,
  isUserCancellation,
  loadPedalMapping,
  pedalMappingsEqual,
  type PedalMapping,
} from '../pedal';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('pedal decoding', () => {
  it('decodes AirTurn single-byte mode', () => {
    expect(decodePedalEvent(bytes(1))).toBe('left');
    expect(decodePedalEvent(bytes(2))).toBe('right');
    expect(decodePedalEvent(bytes(3))).toBe('middle');
    expect(decodePedalEvent(bytes(4))).toBe('aux');
  });

  it('decodes a HID-style bitmask', () => {
    // Multi-byte notifications are unambiguous bitmasks. A single byte of 1..4 is
    // legacy mode instead — see the documented precedence in the module.
    expect(decodePedalEvent(bytes(0x00, 0x01))).toBe('left');
    expect(decodePedalEvent(bytes(0x00, 0x02))).toBe('right');
    expect(decodePedalEvent(bytes(0x00, 0x04))).toBe('middle');
    expect(decodePedalEvent(bytes(0x00, 0x08))).toBe('aux');
  });

  it('resolves the single-byte legacy/bitmask ambiguity deterministically', () => {
    // Legacy wins for 1..4, so single bytes 1-4 name pedals directly. Values
    // outside 1..4 fall through to the bitmask decoder. This is a documented
    // trade-off, not an accident, and it is deterministic either way.
    expect(decodePedalEvent(bytes(1))).toBe('left');
    expect(decodePedalEvent(bytes(2))).toBe('right');
    expect(decodePedalEvent(bytes(3))).toBe('middle');
    expect(decodePedalEvent(bytes(4))).toBe('aux');
    // 0x04 (4) is legacy aux; the bitmask would have read it as middle.
    expect(decodePedalEvent(bytes(0x04))).toBe('aux');
  });

  it('rejects a byte with bits outside the pedal nibble', () => {
    // Guessing here would fire the wrong page turn mid-performance.
    expect(decodePedalEvent(bytes(0x00, 0x10))).toBeNull();
    expect(decodePedalEvent(bytes(0x00, 0xff))).toBeNull();
  });

  it('reads the most recent state byte in a multi-byte notification', () => {
    expect(decodePedalEvent(bytes(0x00, 0x00, 0x02))).toBe('right');
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const buf = bytes(1).buffer;
    expect(decodePedalEvent(buf)).toBe('left');
  });

  it('ignores an all-zero keepalive', () => {
    // A pedal that reports idle state must not be read as a press. This is the
    // difference between "connected but idle" and "spamming page turns", so it
    // is asserted for every zero length, not just one.
    expect(decodePedalEvent(bytes(0, 0, 0))).toBeNull();
    expect(decodePedalEvent(bytes(0))).toBeNull();
    expect(decodePedalEvent(bytes(0, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
    expect(decodePedalEvent(bytes(0x00, 0x00, 0x00))).toBeNull();
  });

  it('never derives a pedal from a payload of only zeros by any route', () => {
    // Guards the keepalive invariant against future refactors: no zero-only
    // payload, of any length, may produce an action.
    for (const length of [1, 2, 3, 4, 8, 16]) {
      expect(decodePedalEvent(new Uint8Array(length)), `length ${length}`).toBeNull();
    }
  });

  it('ignores empty, null and undefined data', () => {
    expect(decodePedalEvent(new Uint8Array([]))).toBeNull();
    expect(decodePedalEvent(null)).toBeNull();
    expect(decodePedalEvent(undefined)).toBeNull();
  });

  it('ignores an unrecognised value rather than guessing', () => {
    expect(decodePedalEvent(bytes(99))).toBeNull();
    expect(decodePedalEvent(bytes(0xff))).toBeNull();
    expect(decodePedalEvent(bytes(0x00, 0x99))).toBeNull();
  });
});

describe('pedal to action mapping', () => {
  it('maps left to previous and right to next by default', () => {
    expect(actionForPedal('left', DEFAULT_PEDAL_MAPPING)).toBe('prevPageOrPiece');
    expect(actionForPedal('right', DEFAULT_PEDAL_MAPPING)).toBe('nextPageOrPiece');
  });

  it('leaves middle and aux unassigned by default', () => {
    // An accidental press should do nothing rather than turn a page.
    expect(DEFAULT_PEDAL_MAPPING.middle).toBeNull();
    expect(DEFAULT_PEDAL_MAPPING.aux).toBeNull();
  });

  it('decodes straight through to an action', () => {
    expect(actionFromBytes(bytes(2), DEFAULT_PEDAL_MAPPING)).toBe('nextPageOrPiece');
    expect(actionFromBytes(bytes(1), DEFAULT_PEDAL_MAPPING)).toBe('prevPageOrPiece');
  });

  it('produces no action for an unassigned pedal', () => {
    expect(actionFromBytes(bytes(3), DEFAULT_PEDAL_MAPPING)).toBeNull();
  });

  it('produces no action for an undecodable payload', () => {
    expect(actionFromBytes(bytes(0, 0, 0), DEFAULT_PEDAL_MAPPING)).toBeNull();
  });

  it('honours a user-edited mapping', () => {
    const custom: PedalMapping = {
      left: 'toggleNightMode',
      right: 'nextPageOrPiece',
      middle: 'toggleMetronome',
      aux: null,
    };
    expect(actionFromBytes(bytes(1), custom)).toBe('toggleNightMode');
    expect(actionFromBytes(bytes(3), custom)).toBe('toggleMetronome');
  });

  it('uses the same action vocabulary as MIDI', () => {
    // Every pedal action must be a real MidiAction so a pedal and a MIDI pedal
    // drive identical stand behaviour.
    for (const action of PEDAL_ACTIONS) {
      expect(['nextPageOrPiece', 'prevPageOrPiece', 'toggleGigMode', 'toggleNightMode',
        'toggleMetronome', 'toggleTuner', 'toggleAudioPlayer', 'togglePitchPipe']).toContain(action);
    }
  });
});

describe('support detection', () => {
  const secure = { isSecureContext: true };

  it('detects support when Web Bluetooth is present', () => {
    expect(isBluetoothPedalSupported({ bluetooth: {} }, secure)).toBe(true);
  });

  it('reports unsupported in a browser without Web Bluetooth', () => {
    expect(isBluetoothPedalSupported({}, secure)).toBe(false);
  });

  it('reports unsupported in an insecure context', () => {
    expect(isBluetoothPedalSupported({ bluetooth: {} }, { isSecureContext: false })).toBe(false);
  });

  it('handles a missing navigator', () => {
    expect(isBluetoothPedalSupported(null, secure)).toBe(false);
    expect(isBluetoothPedalSupported(undefined, secure)).toBe(false);
  });

  it('explains an insecure context specifically', () => {
    expect(bluetoothUnavailableReason({ bluetooth: {} }, { isSecureContext: false })).toContain(
      'secure',
    );
  });

  it('explains an unsupported browser specifically', () => {
    const reason = bluetoothUnavailableReason({}, secure);
    expect(reason).toBeTruthy();
    expect(reason).toContain('does not support');
  });

  it('gives no reason when supported', () => {
    expect(bluetoothUnavailableReason({ bluetooth: {} }, secure)).toBeNull();
  });
});

describe('connection status', () => {
  it('is unsupported when the platform lacks Web Bluetooth', () => {
    expect(
      deriveConnectionStatus({ supported: false, connecting: false, connected: true, error: false }),
    ).toBe('unsupported');
  });

  it('reports connected over connecting when a connect resolves mid-flight', () => {
    // Both flags set happens when a retry lands during an in-flight request.
    // A stale "connecting" is as misleading as a stale "connected".
    expect(
      deriveConnectionStatus({ supported: true, connecting: true, connected: true, error: false }),
    ).toBe('connected');
  });

  it('never reports connected when the device dropped', () => {
    // A stale "connected" indicator mid-performance is the failure to avoid.
    expect(
      deriveConnectionStatus({ supported: true, connecting: false, connected: false, error: false }),
    ).toBe('disconnected');
  });

  it('shows connecting, connected, error and disconnected states', () => {
    const base = { supported: true, connecting: false, connected: false, error: false };
    expect(deriveConnectionStatus(base)).toBe('disconnected');
    expect(deriveConnectionStatus({ ...base, connecting: true })).toBe('connecting');
    expect(deriveConnectionStatus({ ...base, connected: true })).toBe('connected');
    expect(deriveConnectionStatus({ ...base, error: true })).toBe('error');
  });

  it('prioritises error over connected so a failure is visible', () => {
    expect(
      deriveConnectionStatus({ supported: true, connecting: false, connected: true, error: true }),
    ).toBe('error');
  });

  it('describes each state for a screen reader', () => {
    expect(describeConnectionStatus('connected', 'AirTurn BT-200')).toContain('AirTurn BT-200');
    expect(describeConnectionStatus('error')).toContain('failed');
    expect(describeConnectionStatus('disconnected')).toContain('not connected');
    expect(describeConnectionStatus('connecting')).toContain('Connecting');
    expect(describeConnectionStatus('unsupported')).toBeTruthy();
  });
});

describe('user cancellation', () => {
  it('recognises the browser cancellation errors', () => {
    expect(isUserCancellation({ name: 'NotFoundError' })).toBe(true);
    expect(isUserCancellation({ name: 'AbortError' })).toBe(true);
  });

  it('does not treat a real failure as cancellation', () => {
    expect(isUserCancellation({ name: 'NetworkError' })).toBe(false);
    expect(isUserCancellation(new Error('boom'))).toBe(false);
    expect(isUserCancellation(null)).toBe(false);
  });
});

describe('mapping persistence', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPedalMapping(null)).toEqual(DEFAULT_PEDAL_MAPPING);
    expect(loadPedalMapping(undefined)).toEqual(DEFAULT_PEDAL_MAPPING);
    expect(loadPedalMapping('garbage')).toEqual(DEFAULT_PEDAL_MAPPING);
  });

  it('restores a stored mapping', () => {
    const stored = { left: 'toggleNightMode', right: 'nextPageOrPiece', middle: null, aux: null };
    expect(loadPedalMapping(stored)).toEqual(stored);
  });

  it('drops a stored value that is no longer a valid action', () => {
    // A removed action must not be dispatchable at runtime.
    const loaded = loadPedalMapping({ left: 'selfDestruct', right: 'nextPageOrPiece' });
    expect(loaded.left).toBe('prevPageOrPiece');
    expect(loaded.right).toBe('nextPageOrPiece');
  });

  it('honours an explicit null (pedal deliberately unassigned)', () => {
    const loaded = loadPedalMapping({ left: null, right: 'nextPageOrPiece' });
    expect(loaded.left).toBeNull();
  });

  it('compares mappings for redundant-save avoidance', () => {
    expect(pedalMappingsEqual(DEFAULT_PEDAL_MAPPING, { ...DEFAULT_PEDAL_MAPPING })).toBe(true);
    expect(
      pedalMappingsEqual(DEFAULT_PEDAL_MAPPING, { ...DEFAULT_PEDAL_MAPPING, left: 'toggleTuner' }),
    ).toBe(false);
  });
});
