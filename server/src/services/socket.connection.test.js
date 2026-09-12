import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Failure-injection coverage for the Socket.IO connection lifecycle itself
// (connect / register / error / disconnect / reconnect) -- socket.test.js
// covers the chat/meeting email side-effects, this covers connection
// resilience: state cleanup on disconnect, a fresh register after
// reconnect re-establishing presence, and connection error metrics.
const setOnlineMock = vi.fn(async () => {});
const removeOnlineMock = vi.fn(async () => {});
const removeLocationMock = vi.fn(async () => {});
const getOnlineNicknamesMock = vi.fn(async () => []);

vi.mock('./email.js', () => ({
  sendVideoMeetingStartedAlert: vi.fn(async () => {}),
  sendDirectMessageEmail: vi.fn(async () => {}),
  sendVideoMeetingStartedToUsers: vi.fn(async () => {}),
}));
vi.mock('./database.js', () => ({
  getUserEmailByNickname: vi.fn(async () => null),
  getUserEmailRecipients: vi.fn(async () => []),
}));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
vi.mock('../lib/onlineState.js', () => ({
  setOnline: (...args) => setOnlineMock(...args),
  removeOnline: (...args) => removeOnlineMock(...args),
  getOnlineNicknames: (...args) => getOnlineNicknamesMock(...args),
  getOnlineSocketId: vi.fn(async () => undefined),
  isNewDirectMessageConversation: vi.fn(async () => true),
  setLocation: vi.fn(async () => {}),
  removeLocation: (...args) => removeLocationMock(...args),
  getAllLocations: vi.fn(async () => ({})),
}));

const { initSocketHandlers } = await import('./socket.js');
const { JWT_SECRET } = await import('../lib/jwtSecret.js');
const { getMetricsSnapshot } = await import('../lib/requestMetrics.js');

function createFakeIo() {
  const connectionHandlers = [];
  const io = {
    on: (event, cb) => { if (event === 'connection') connectionHandlers.push(cb); },
    emit: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
    socketsLeave: vi.fn(),
  };
  return { io, connect: (socket) => connectionHandlers.forEach((cb) => cb(socket)) };
}

function createFakeSocket(id = 'sock-1') {
  const handlers = {};
  const socket = {
    id,
    handshake: { auth: {} },
    on: (event, cb) => { handlers[event] = cb; },
    emit: vi.fn(),
    broadcast: { emit: vi.fn() },
    to: vi.fn(() => ({ emit: vi.fn() })),
    join: vi.fn(),
    leave: vi.fn(),
    rooms: new Set([id]),
  };
  return { socket, handlers };
}

function nicknameToken(nickname, extra = {}) {
  return jwt.sign({ nickname, ...extra }, JWT_SECRET, { expiresIn: '1h' });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('socket connection lifecycle', () => {
  it('records a successful connection metric', () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket } = createFakeSocket();
    connect(socket);

    const entry = getMetricsSnapshot().find((m) => m.name === 'socket.connection');
    expect(entry.count).toBeGreaterThan(0);
  });

  it('records a failed connection metric on a socket error event', () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);

    const before = getMetricsSnapshot().find((m) => m.name === 'socket.connection');
    handlers.error(new Error('transport close'));
    const after = getMetricsSnapshot().find((m) => m.name === 'socket.connection');

    expect(after.count).toBe(before.count + 1);
    expect(after.errors).toBeGreaterThan(before.errors);
  });

  it('authenticates from the httpOnly session cookie when no explicit token is sent (web path)', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    socket.handshake.headers = { cookie: `bqi_jwt=${nicknameToken('BOLD-COOKIE')}` };
    connect(socket);

    await handlers.register({});
    await flush();
    expect(setOnlineMock).toHaveBeenCalledWith('BOLD-COOKIE', socket.id);
  });

  it('prefers an explicit token over the cookie when both are present', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    socket.handshake.headers = { cookie: `bqi_jwt=${nicknameToken('FROM-COOKIE')}` };
    connect(socket);

    await handlers.register({ token: nicknameToken('FROM-TOKEN') });
    await flush();
    expect(setOnlineMock).toHaveBeenCalledWith('FROM-TOKEN', socket.id);
  });

  it('cleans up presence state on disconnect', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);

    await handlers.register({ token: nicknameToken('BOLD-001') });
    await flush();
    expect(setOnlineMock).toHaveBeenCalledWith('BOLD-001', socket.id);

    await handlers.disconnect();
    expect(removeOnlineMock).toHaveBeenCalledWith('BOLD-001');
    expect(removeLocationMock).toHaveBeenCalledWith('BOLD-001');
  });

  it('re-establishes presence after a reconnect (new socket, same user)', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);

    const first = createFakeSocket('sock-1');
    connect(first.socket);
    await first.handlers.register({ token: nicknameToken('BOLD-001') });
    await flush();
    await first.handlers.disconnect();

    // Reconnect: a brand new socket (new transport connection), same user
    // registering again -- this is what a client's automatic Socket.IO
    // reconnect looks like server-side.
    const second = createFakeSocket('sock-2');
    connect(second.socket);
    await second.handlers.register({ token: nicknameToken('BOLD-001') });
    await flush();

    expect(setOnlineMock).toHaveBeenCalledWith('BOLD-001', 'sock-1');
    expect(setOnlineMock).toHaveBeenCalledWith('BOLD-001', 'sock-2');
    expect(setOnlineMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw when a socket disconnects before ever registering', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);

    await expect(handlers.disconnect()).resolves.not.toThrow();
    expect(removeOnlineMock).not.toHaveBeenCalled();
  });
});
