import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

afterEach(() => {
  delete window.bqiDesktop;
  vi.resetModules();
});

describe('ReauthBanner', () => {
  it('renders nothing on the web build (no window.bqiDesktop)', async () => {
    const { default: ReauthBanner } = await import('./ReauthBanner.jsx');
    const { container } = render(<ReauthBanner onLogout={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the cached session does not need reauth', async () => {
    window.bqiDesktop = {
      isDesktop: true,
      auth: { needsReauth: async () => false, onReauthRequired: () => () => {} },
    };
    vi.resetModules();
    const { default: ReauthBanner } = await import('./ReauthBanner.jsx');
    const { container } = render(<ReauthBanner onLogout={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the banner when the cached session already needs reauth on mount', async () => {
    window.bqiDesktop = {
      isDesktop: true,
      auth: { needsReauth: async () => true, onReauthRequired: () => () => {} },
    };
    vi.resetModules();
    const { default: ReauthBanner } = await import('./ReauthBanner.jsx');
    render(<ReauthBanner onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText('Tekrar Giriş Yap')).toBeInTheDocument());
  });

  it('shows the banner once a live reauthRequired event fires, and clicking the button calls onLogout', async () => {
    let pushEvent;
    window.bqiDesktop = {
      isDesktop: true,
      auth: {
        needsReauth: async () => false,
        onReauthRequired: (cb) => { pushEvent = cb; return () => {}; },
      },
    };
    vi.resetModules();
    const { default: ReauthBanner } = await import('./ReauthBanner.jsx');
    const onLogout = vi.fn();
    render(<ReauthBanner onLogout={onLogout} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Tekrar Giriş Yap')).not.toBeInTheDocument();

    act(() => { pushEvent(); });
    await waitFor(() => expect(screen.getByText('Tekrar Giriş Yap')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Tekrar Giriş Yap'));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
