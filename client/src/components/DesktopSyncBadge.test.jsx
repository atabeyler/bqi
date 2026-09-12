import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

afterEach(() => {
  delete window.bqiDesktop;
  localStorage.removeItem('bqi_app_mode');
  vi.resetModules();
});

describe('DesktopSyncBadge', () => {
  it('renders nothing on the web build (no window.bqiDesktop)', async () => {
    const { default: DesktopSyncBadge } = await import('./DesktopSyncBadge.jsx');
    const { container } = render(<DesktopSyncBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Q CLOUD when the desktop bridge reports cloud state', async () => {
    window.bqiDesktop = {
      isDesktop: true,
      sync: { status: async () => ({ state: 'cloud' }) },
      connectivity: { onChange: () => () => {} },
    };
    vi.resetModules();
    const { default: DesktopSyncBadge } = await import('./DesktopSyncBadge.jsx');
    render(<DesktopSyncBadge />);
    await waitFor(() => expect(screen.getByText('Q CLOUD')).toBeInTheDocument());
  });

  it('shows Q LOCAL when offline', async () => {
    window.bqiDesktop = {
      isDesktop: true,
      sync: { status: async () => ({ state: 'local' }) },
      connectivity: { onChange: () => () => {} },
    };
    vi.resetModules();
    const { default: DesktopSyncBadge } = await import('./DesktopSyncBadge.jsx');
    render(<DesktopSyncBadge />);
    await waitFor(() => expect(screen.getByText('Q LOCAL')).toBeInTheDocument());
  });

  it('shows the distinct manual-offline badge when Offline Mode is on and connectivity is local', async () => {
    const { setAppMode } = await import('../services/appModePreference.js');
    setAppMode('offline');
    window.bqiDesktop = {
      isDesktop: true,
      sync: { status: async () => ({ state: 'local' }) },
      connectivity: { onChange: () => () => {} },
    };
    vi.resetModules();
    const { default: DesktopSyncBadge } = await import('./DesktopSyncBadge.jsx');
    render(<DesktopSyncBadge />);
    await waitFor(() => expect(screen.getByText('Q LOCAL · MANUEL')).toBeInTheDocument());
    expect(screen.queryByText('Q LOCAL')).not.toBeInTheDocument();
  });

  // Regression: items 12-13 fixed effectiveState to key off appModeOffline
  // alone, not `appModeOffline && state === 'local'` -- the underlying
  // connectivity state is stale once Offline Mode stops the poller (see
  // desktop/appMode.js's set('offline')), so a leftover 'cloud' reading must
  // not suppress the manual badge.
  it('shows the manual-offline badge when Offline Mode is on even if the (stale) connectivity state is cloud', async () => {
    const { setAppMode } = await import('../services/appModePreference.js');
    setAppMode('offline');
    window.bqiDesktop = {
      isDesktop: true,
      sync: { status: async () => ({ state: 'cloud' }) },
      connectivity: { onChange: () => () => {} },
    };
    vi.resetModules();
    const { default: DesktopSyncBadge } = await import('./DesktopSyncBadge.jsx');
    render(<DesktopSyncBadge />);
    await waitFor(() => expect(screen.getByText('Q LOCAL · MANUEL')).toBeInTheDocument());
    expect(screen.queryByText('Q CLOUD')).not.toBeInTheDocument();
  });
});
