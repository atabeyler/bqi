import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PersonnelRadar, { RadarModal } from './PersonnelRadar.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { executeAction } from '../services/voiceActionRegistry.js';

const fakeSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
vi.mock('../services/socket.js', () => ({ getSocket: () => fakeSocket }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PersonnelRadar (button)', () => {
  it('renders nothing for a non-admin', () => {
    const { container } = render(<LangProvider><PersonnelRadar isAdmin={false} onOpen={vi.fn()} /></LangProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a RADAR button for an admin and opens on click', () => {
    const onOpen = vi.fn();
    render(<LangProvider><PersonnelRadar isAdmin onOpen={onOpen} /></LangProvider>);
    fireEvent.click(screen.getByText('RADAR'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('registers an open_radar voice action for admins', async () => {
    const onOpen = vi.fn();
    render(<LangProvider><PersonnelRadar isAdmin onOpen={onOpen} /></LangProvider>);
    await executeAction('open_radar');
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('RadarModal', () => {
  it('requests location updates from the socket on mount', () => {
    render(<RadarModal onClose={vi.fn()} lang="tr" />);
    expect(fakeSocket.emit).toHaveBeenCalledWith('locations:request');
    expect(fakeSocket.on).toHaveBeenCalledWith('locations:update', expect.any(Function));
  });

  it('closes when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<RadarModal onClose={onClose} lang="tr" />);
    fireEvent.click(screen.getByLabelText('Kapat'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders personnel entries from a locations:update event, excluding BOLD (the admin itself)', () => {
    render(<RadarModal onClose={vi.fn()} lang="tr" />);
    const onUpdate = fakeSocket.on.mock.calls.find(([event]) => event === 'locations:update')[1];
    act(() => onUpdate({
      'BOLD-001': { lat: 39.9, lng: 32.8, updatedAt: Date.now() },
      BOLD: { lat: 41.0, lng: 28.9, updatedAt: Date.now() },
    }));
    // Rendered twice -- once as the radar marker label, once in the right-panel list.
    expect(screen.getAllByText('BOLD-001').length).toBe(2);
    expect(screen.queryAllByText('BOLD').length).toBe(0);
  });

  it('selects a marker and shows its coordinate details', () => {
    render(<RadarModal onClose={vi.fn()} lang="tr" />);
    const onUpdate = fakeSocket.on.mock.calls.find(([event]) => event === 'locations:update')[1];
    act(() => onUpdate({ 'BOLD-002': { lat: 38.4, lng: 27.1, updatedAt: Date.now() } }));
    fireEvent.click(screen.getAllByText('BOLD-002')[0]);
    expect(screen.getByText('Haritada Aç ↗')).toBeInTheDocument();
  });
});
