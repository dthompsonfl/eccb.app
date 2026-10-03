/**
 * Tests for TransportStatus — the component that makes a realtime downgrade
 * visible instead of silent.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransportStatus } from '../TransportStatus';

describe('TransportStatus', () => {
  it('renders nothing while realtime is working', () => {
    const { container } = render(
      <TransportStatus requested="websocket" isPollingFallback={false} pollingIntervalMs={5000} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when polling was the configured transport', () => {
    // A polling-only deployment is not a degraded state and must not nag.
    const { container } = render(
      <TransportStatus requested="polling" isPollingFallback pollingIntervalMs={5000} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says so when a websocket client fell back to polling', () => {
    render(
      <TransportStatus requested="websocket" isPollingFallback pollingIntervalMs={5000} />,
    );
    const status = screen.getByTestId('stand-transport-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status.textContent).toContain('Live sync unavailable');
    expect(status.textContent).toContain('5s');
  });

  it('reports the configured interval rather than a hard-coded one', () => {
    render(
      <TransportStatus requested="websocket" isPollingFallback pollingIntervalMs={2000} />,
    );
    expect(screen.getByTestId('stand-transport-status').textContent).toContain('2s');
  });

  it('offers a retry that calls back when a reconnect handler is supplied', () => {
    const onReconnect = vi.fn();
    render(
      <TransportStatus
        requested="websocket"
        isPollingFallback
        pollingIntervalMs={5000}
        onReconnect={onReconnect}
      />,
    );
    const button = screen.getByRole('button', { name: /retry live sync/i });
    button.click();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
