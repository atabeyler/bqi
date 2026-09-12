import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

afterEach(() => {
  delete window.bqiDesktop;
  vi.resetModules();
});

const conflict = {
  id: 'c1',
  entityType: 'analysis',
  entityId: 'r1',
  localPayload: { title: 'Yerel başlık', content: 'Yerel içerik burada' },
  serverPayload: { title: 'Bulut başlık', content: 'Bulut içerik burada' },
  serverVersion: 2,
  serverDeleted: false,
};

describe('DesktopConflictModal', () => {
  it('renders nothing on the web build', async () => {
    const { default: DesktopConflictModal } = await import('./DesktopConflictModal.jsx');
    const { container } = render(<DesktopConflictModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no conflicts', async () => {
    window.bqiDesktop = { isDesktop: true, sync: { listConflicts: async () => [] } };
    vi.resetModules();
    const { default: DesktopConflictModal } = await import('./DesktopConflictModal.jsx');
    const { container } = render(<DesktopConflictModal />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows both sides of a conflict and lets the user pick one', async () => {
    const resolveConflict = vi.fn(async () => true);
    window.bqiDesktop = {
      isDesktop: true,
      sync: { listConflicts: async () => [conflict], resolveConflict },
    };
    vi.resetModules();
    const { default: DesktopConflictModal } = await import('./DesktopConflictModal.jsx');
    render(<DesktopConflictModal />);

    await waitFor(() => expect(screen.getByText('Yerel başlık')).toBeInTheDocument());
    expect(screen.getByText('Bulut başlık')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Yerel sürümü kullan'));
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith('c1', 'kept_local'));
  });
});
