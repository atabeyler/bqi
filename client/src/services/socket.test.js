import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal fake socket.io-client socket: enough of an event emitter for
// connectSocket()'s on('connect')/emit('register') usage, plus a
// `connected` flag the fixture can flip to simulate the handshake
// completing.
function makeFakeSocket() {
  const listeners = {};
  return {
    connected: false,
    auth: null,
    on(event, cb) { (listeners[event] ||= []).push(cb); },
    emit: vi.fn(),
    disconnect: vi.fn(),
    _fireConnect() {
      this.connected = true;
      (listeners.connect || []).forEach((cb) => cb());
    },
  };
}

const ioMock = vi.fn();
vi.mock('socket.io-client', () => ({ io: (...args) => ioMock(...args) }));
vi.mock('./api.js', () => ({ getSocketBaseUrl: () => 'https://api.test' }));

describe('connectSocket', () => {
  beforeEach(() => {
    vi.resetModules();
    ioMock.mockReset();
  });

  it('creates exactly one socket even when called again before the first connect event fires', async () => {
    const fake = makeFakeSocket();
    ioMock.mockReturnValue(fake);
    const { connectSocket } = await import('./socket.js');

    // Simulates DashboardPage and EmergencyChatPanel both calling
    // connectSocket() in their own mount effects before the handshake
    // completes -- the bug this regression test guards against previously
    // created a second, orphaned io() instance here.
    const first = connectSocket('BOLD-001', 'tok');
    const second = connectSocket('BOLD-001', 'tok');

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('registers with the most recently requested nickname/token on connect, not the first caller\'s', async () => {
    const fake = makeFakeSocket();
    ioMock.mockReturnValue(fake);
    const { connectSocket } = await import('./socket.js');

    connectSocket('STALE-NAME', 'stale-token');
    connectSocket('FRESH-NAME', 'fresh-token');
    fake._fireConnect();

    expect(fake.emit).toHaveBeenCalledWith('register', { nickname: 'FRESH-NAME', token: 'fresh-token' });
  });

  it('re-registers immediately when called again on an already-connected socket', async () => {
    const fake = makeFakeSocket();
    ioMock.mockReturnValue(fake);
    const { connectSocket } = await import('./socket.js');

    connectSocket('A', 't1');
    fake._fireConnect();
    fake.emit.mockClear();

    connectSocket('B', 't2');
    expect(fake.emit).toHaveBeenCalledWith('register', { nickname: 'B', token: 't2' });
    expect(fake.auth).toEqual({ token: 't2' });
  });

  it('creates a new socket after disconnectSocket()', async () => {
    const fake1 = makeFakeSocket();
    const fake2 = makeFakeSocket();
    ioMock.mockReturnValueOnce(fake1).mockReturnValueOnce(fake2);
    const { connectSocket, disconnectSocket } = await import('./socket.js');

    const a = connectSocket('A', 't');
    disconnectSocket();
    const b = connectSocket('A', 't');

    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(fake1.disconnect).toHaveBeenCalled();
  });
});
