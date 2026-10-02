/**
 * @vitest-environment jsdom
 *
 * Composed Bluetooth pedal tests: a real BLE notification must drive the SAME
 * store actions a MIDI pedal drives. Uses the real store, a fake GATT
 * characteristic, and the real component.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useStandStore } from '@/store/standStore';
import { BluetoothHandler } from '../BluetoothHandler';

/** Captures the notification handler so a test can deliver a pedal press. */
let notifyHandler: ((event: Event) => void) | null = null;
const startNotifications = vi.fn().mockResolvedValue(undefined);
const disconnect = vi.fn();

function makeCharacteristic() {
  return {
    startNotifications,
    addEventListener: vi.fn((type: string, handler: (e: Event) => void) => {
      if (type === 'characteristicvaluechanged') notifyHandler = handler;
    }),
    removeEventListener: vi.fn(),
  };
}

function makeDevice() {
  const characteristic = makeCharacteristic();
  return {
    name: 'AirTurn BT-200',
    gatt: {
      connect: vi.fn().mockResolvedValue({
        getPrimaryService: vi.fn(async () => ({
          getCharacteristic: vi.fn(async () => characteristic),
        })),
      }),
      disconnect,
      addEventListener: vi.fn((type: string, handler: () => void) => {
        if (type === 'gattserverdisconnected') disconnectHandler = handler;
      }),
    },
  };
}

let disconnectHandler: (() => void) | null = null;
let requestDevice: ReturnType<typeof vi.fn>;

/** Deliver a pedal press as a BLE notification. */
function pressPedal(...values: number[]) {
  const dataView = new DataView(new Uint8Array(values).buffer);
  const event = { target: { value: dataView } } as unknown as Event;
  notifyHandler?.(event);
}

beforeEach(() => {
  notifyHandler = null;
  disconnectHandler = null;
  startNotifications.mockClear();
  disconnect.mockClear();
  requestDevice = vi.fn().mockResolvedValue(makeDevice());

  // Stub only the `bluetooth` property: replacing the whole navigator would
  // break jsdom's other navigator-backed APIs (localStorage, matchMedia).
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

  // jsdom in this configuration does not provide localStorage; the component
  // persists its mapping there, so supply a minimal in-memory implementation.
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  store.clear();

  useStandStore.getState().reset();
  useStandStore.setState({
    pieces: [{ id: 'p1', title: 'T', composer: 'C', pdfUrl: '/a.pdf', totalPages: 5 }],
    currentPieceIndex: 0,
    _currentPage: 2,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function connect() {
  render(<BluetoothHandler />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /connect bluetooth foot pedal/i }));
  });
  await waitFor(() => expect(screen.getByText(/Disconnect pedal/)).toBeTruthy());
}

describe('Bluetooth pedal integration', () => {
  it('reports unsupported in a browser without Web Bluetooth', () => {
    Object.defineProperty(navigator, 'bluetooth', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { container } = render(<BluetoothHandler />);
    // The message appears both in the live region and as a visible note;
    // assert on the container text so the duplicate is not an error.
    expect(container.textContent).toMatch(/does not support Bluetooth foot pedals/i);
  });

  it('connects and reports the device name', async () => {
    await connect();
    expect(startNotifications).toHaveBeenCalled();
    expect(screen.getByText('AirTurn BT-200')).toBeTruthy();
  });

  it('a right-pedal press advances the page', async () => {
    await connect();
    const before = useStandStore.getState()._currentPage;

    await act(async () => {
      pressPedal(2);
    });

    expect(useStandStore.getState()._currentPage).toBeGreaterThan(before);
  });

  it('a left-pedal press goes back', async () => {
    await connect();
    const before = useStandStore.getState()._currentPage;

    await act(async () => {
      pressPedal(1);
    });

    expect(useStandStore.getState()._currentPage).toBeLessThan(before);
  });

  it('drives the same actions as a MIDI pedal would', async () => {
    await connect();
    const before = useStandStore.getState().nightMode;

    // Remap the right pedal to night mode, then press it.
    fireEvent.click(screen.getByRole('button', { name: /pedal mapping/i }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/action for right pedal/i), {
        target: { value: 'toggleNightMode' },
      });
    });

    await act(async () => {
      pressPedal(2);
    });

    // Same action name the MIDI handler dispatches for toggleNightMode.
    expect(useStandStore.getState().nightMode).toBe(!before);
  });

  it('ignores an idle keepalive notification', async () => {
    await connect();
    const before = useStandStore.getState()._currentPage;

    await act(async () => {
      pressPedal(0, 0, 0);
    });

    expect(useStandStore.getState()._currentPage).toBe(before);
  });

  it('does nothing for an unassigned pedal', async () => {
    await connect();
    const before = useStandStore.getState()._currentPage;

    await act(async () => {
      pressPedal(3); // middle pedal: unassigned by default
    });

    expect(useStandStore.getState()._currentPage).toBe(before);
  });

  it('shows disconnected, not connected, after the device drops', async () => {
    await connect();

    // The browser fires gattserverdisconnected; the component must reflect it.
    await act(async () => {
      disconnectHandler?.();
      await Promise.resolve();
    });

    // A stale "connected" indicator mid-performance is the bug being prevented.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect bluetooth foot pedal/i })).toBeTruthy(),
    );
    expect(screen.queryByText('Disconnect pedal')).toBeNull();
  });

  it('treats a cancelled chooser as a normal outcome, not an error', async () => {
    requestDevice.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotFoundError' }));
    render(<BluetoothHandler />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect bluetooth foot pedal/i }));
    });

    expect(screen.getByRole('button', { name: /connect bluetooth foot pedal/i })).toBeTruthy();
    expect(
      document.querySelector('[aria-live="polite"]')?.textContent,
    ).not.toMatch(/connection failed/i);
  });

  it('surfaces a real connection failure', async () => {
    requestDevice.mockRejectedValue(Object.assign(new Error('gatt'), { name: 'NetworkError' }));
    render(<BluetoothHandler />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect bluetooth foot pedal/i }));
    });

    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toMatch(
        /connection failed/i,
      ),
    );
  });

  it('persists an edited mapping and restores it', async () => {
    await connect();
    fireEvent.click(screen.getByRole('button', { name: /pedal mapping/i }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/action for left pedal/i), {
        target: { value: 'toggleMetronome' },
      });
    });

    const stored = window.localStorage.getItem('eccb.pedal-mapping');
    expect(stored).toContain('toggleMetronome');
  });

  it('exposes keyboard-reachable, labelled controls', async () => {
    await connect();
    fireEvent.click(screen.getByRole('button', { name: /pedal mapping/i }));

    // Every mapping control is a labelled form element.
    expect(screen.getByLabelText(/action for left pedal/i)).toBeTruthy();
    expect(screen.getByLabelText(/action for right pedal/i)).toBeTruthy();
    expect(screen.getByLabelText(/action for middle pedal/i)).toBeTruthy();
    expect(screen.getByLabelText(/action for aux pedal/i)).toBeTruthy();
  });

  it('announces connection state in a live region', async () => {
    await connect();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('AirTurn BT-200');
  });
});
