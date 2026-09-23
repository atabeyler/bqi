import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import ChatPanel from './EmergencyChatPanel.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { setAppMode } from '../services/appModePreference.js';

// Mirrors EmergencyButton.test.jsx's socket mock, but with a real per-call
// event-emitter fake instead of a single shared stub, so the
// reconnect/reattach fix (item 9) can be told apart from the pre-fix
// behavior: a fresh socket instance per connectSocket() call, with its own
// on/off bookkeeping, plus a test-only _trigger() to simulate an incoming
// server event on a specific instance.
let sockets = [];
function makeFakeSocket(id) {
  const listeners = {};
  return {
    id,
    connected: true,
    on: vi.fn((event, cb) => { (listeners[event] ||= []).push(cb); }),
    off: vi.fn((event, cb) => { listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb); }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    _trigger: (event, payload) => { (listeners[event] || []).forEach((fn) => fn(payload)); },
    _hasListener: (event) => (listeners[event] || []).length > 0,
  };
}

let currentSocket = null;
const connectSocketMock = vi.fn(() => {
  const sock = makeFakeSocket(`sock-${sockets.length}`);
  sockets.push(sock);
  currentSocket = sock;
  return sock;
});
const disconnectSocketMock = vi.fn(() => {
  if (currentSocket) currentSocket.connected = false;
  currentSocket = null;
});
const getSocketMock = vi.fn(() => currentSocket);

vi.mock('../services/socket.js', () => ({
  connectSocket: (...args) => connectSocketMock(...args),
  disconnectSocket: (...args) => disconnectSocketMock(...args),
  getSocket: (...args) => getSocketMock(...args),
}));

vi.mock('../services/api.js', () => ({
  api: {
    emergencyCenter: vi.fn(async () => ({ success: true })),
    directory: vi.fn(async () => ['BOLD-001', 'BOLD-002']),
  },
  getToken: vi.fn(() => 'fake-jwt'),
}));

const defaultUser = { userCode: 'BOLD-001', nickname: 'BOLD-001', isAdmin: false };

function renderPanel(props = {}) {
  return render(<LangProvider><ChatPanel user={defaultUser} {...props} /></LangProvider>);
}

beforeEach(() => {
  sockets = [];
  currentSocket = null;
  vi.clearAllMocks();
  localStorage.removeItem('bqi_app_mode');
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  localStorage.removeItem('bqi_app_mode');
});

describe('EmergencyChatPanel socket reconnect under Offline Mode', () => {
  it('connects and attaches listeners in Auto, detaches + disconnects on Offline, and reattaches live listeners on a fresh socket when Auto returns', async () => {
    renderPanel();

    // Auto -> mount effect connects and attaches listeners.
    await waitFor(() => expect(connectSocketMock).toHaveBeenCalledTimes(1));
    const firstSocket = sockets[0];
    expect(firstSocket._hasListener('chat:receive')).toBe(true);

    // Offline ON -> the live subscribeAppModePreference listener detaches
    // and disconnects the still-connected socket immediately.
    act(() => { setAppMode('offline'); });
    await waitFor(() => expect(disconnectSocketMock).toHaveBeenCalledTimes(1));
    expect(firstSocket.off).toHaveBeenCalledWith('chat:receive', expect.any(Function));
    expect(firstSocket._hasListener('chat:receive')).toBe(false);

    // Offline OFF -> ConnectionPanel dispatches aq:app-mode-reconnect; since
    // getSocket() is now null (disconnected), the handler connects a brand
    // new socket and reattaches listeners onto it.
    act(() => {
      setAppMode('auto');
      window.dispatchEvent(new CustomEvent('aq:app-mode-reconnect'));
    });
    await waitFor(() => expect(connectSocketMock).toHaveBeenCalledTimes(2));
    const secondSocket = sockets[1];
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket._hasListener('chat:receive')).toBe(true);

    // A chat:receive fired on the OLD (orphaned) socket must not be handled
    // -- proves the old listeners are really gone, not just shadowed.
    act(() => { firstSocket._trigger('chat:receive', { from: 'BOLD-002', message: 'eski-soket-mesaji' }); });
    expect(screen.queryByText(/eski-soket-mesaji/)).not.toBeInTheDocument();

    // A chat:receive fired on the NEW socket must be handled -- proves the
    // reattached listeners are live on the new instance.
    act(() => { secondSocket._trigger('chat:receive', { from: 'BOLD-002', message: 'yeni-soket-mesaji' }); });
    await waitFor(() => expect(screen.getByText(/yeni-soket-mesaji/)).toBeInTheDocument());
  });

  it('does not connect at mount when Offline Mode is already on', () => {
    setAppMode('offline');
    renderPanel();
    expect(connectSocketMock).not.toHaveBeenCalled();
  });
});
