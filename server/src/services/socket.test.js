import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendVideoMeetingStartedAlertMock = vi.fn(async () => {});
const sendDirectMessageEmailMock = vi.fn(async () => {});
const sendVideoMeetingStartedToUsersMock = vi.fn(async () => {});
const getUserEmailByNicknameMock = vi.fn(async () => null);
const getUserEmailRecipientsMock = vi.fn(async () => []);
const getOnlineSocketIdMock = vi.fn(async () => undefined);
const isNewDirectMessageConversationMock = vi.fn(async () => true);

vi.mock('./email.js', () => ({
  sendVideoMeetingStartedAlert: (...args) => sendVideoMeetingStartedAlertMock(...args),
  sendDirectMessageEmail: (...args) => sendDirectMessageEmailMock(...args),
  sendVideoMeetingStartedToUsers: (...args) => sendVideoMeetingStartedToUsersMock(...args),
}));
vi.mock('./database.js', () => ({
  getUserEmailByNickname: (...args) => getUserEmailByNicknameMock(...args),
  getUserEmailRecipients: (...args) => getUserEmailRecipientsMock(...args),
}));
vi.mock('../db/client.js', () => ({ isDbConfigured: () => false, getDb: () => { throw new Error('not used when isDbConfigured() is false'); } }));
vi.mock('../lib/onlineState.js', () => ({
  setOnline: vi.fn(async () => {}),
  removeOnline: vi.fn(async () => {}),
  getOnlineNicknames: vi.fn(async () => []),
  getOnlineSocketId: (...args) => getOnlineSocketIdMock(...args),
  isNewDirectMessageConversation: (...args) => isNewDirectMessageConversationMock(...args),
  setLocation: vi.fn(async () => {}),
  removeLocation: vi.fn(async () => {}),
  getAllLocations: vi.fn(async () => ({})),
}));

const { initSocketHandlers } = await import('./socket.js');

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

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  getOnlineSocketIdMock.mockResolvedValue(undefined);
  getUserEmailByNicknameMock.mockResolvedValue(null);
  getUserEmailRecipientsMock.mockResolvedValue([]);
  isNewDirectMessageConversationMock.mockResolvedValue(true);
});

describe('chat:send (emails the recipient once per new conversation, active or not)', () => {
  it('emails the recipient when they are not currently connected', async () => {
    getOnlineSocketIdMock.mockResolvedValue(undefined);
    getUserEmailByNicknameMock.mockResolvedValue('offline@example.com');

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD-001';

    await handlers['chat:send']({ to: 'BOLD-002', message: 'merhaba' });
    await flushMicrotasks();

    expect(getUserEmailByNicknameMock).toHaveBeenCalledWith('BOLD-002');
    expect(sendDirectMessageEmailMock).toHaveBeenCalledWith('offline@example.com', 'BOLD-002', 'BOLD-001', 'merhaba');
  });

  it('also emails the recipient when they are online (app may be backgrounded)', async () => {
    getOnlineSocketIdMock.mockResolvedValue('their-socket-id');
    getUserEmailByNicknameMock.mockResolvedValue('online@example.com');

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD-001';

    await handlers['chat:send']({ to: 'BOLD-002', message: 'merhaba' });
    await flushMicrotasks();

    expect(sendDirectMessageEmailMock).toHaveBeenCalledWith('online@example.com', 'BOLD-002', 'BOLD-001', 'merhaba');
  });

  it('does not attempt to email when the recipient has no email on file', async () => {
    getOnlineSocketIdMock.mockResolvedValue(undefined);
    getUserEmailByNicknameMock.mockResolvedValue(null);

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD-001';

    await handlers['chat:send']({ to: 'BOLD-002', message: 'merhaba' });
    await flushMicrotasks();

    expect(sendDirectMessageEmailMock).not.toHaveBeenCalled();
  });

  it('does not email again for a later message in the same conversation', async () => {
    getUserEmailByNicknameMock.mockResolvedValue('offline@example.com');
    isNewDirectMessageConversationMock.mockResolvedValue(false);

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD-001';

    await handlers['chat:send']({ to: 'BOLD-002', message: 'ikinci mesaj' });
    await flushMicrotasks();

    expect(getUserEmailByNicknameMock).not.toHaveBeenCalled();
    expect(sendDirectMessageEmailMock).not.toHaveBeenCalled();
  });
});

describe('video:meeting:start (email everyone, active or not)', () => {
  it('emails every registered user when an admin starts a meeting', async () => {
    getUserEmailRecipientsMock.mockResolvedValue([
      { user_code: 'BOLD-001', nickname: 'BOLD-001', email: 'u1@example.com' },
      { user_code: 'BOLD-002', nickname: 'BOLD-002', email: 'u2@example.com' },
    ]);

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD';
    socket.isAdmin = true;

    handlers['video:meeting:start']();
    await flushMicrotasks();

    expect(sendVideoMeetingStartedAlertMock).toHaveBeenCalledWith('BOLD');
    expect(sendVideoMeetingStartedToUsersMock).toHaveBeenCalledWith('BOLD', [
      { user_code: 'BOLD-001', nickname: 'BOLD-001', email: 'u1@example.com' },
      { user_code: 'BOLD-002', nickname: 'BOLD-002', email: 'u2@example.com' },
    ]);
  });

  it('does not attempt to email anyone when no user has an email on file', async () => {
    getUserEmailRecipientsMock.mockResolvedValue([]);

    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD';
    socket.isAdmin = true;

    handlers['video:meeting:start']();
    await flushMicrotasks();

    expect(sendVideoMeetingStartedToUsersMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a non-admin socket', async () => {
    const { io, connect } = createFakeIo();
    initSocketHandlers(io);
    const { socket, handlers } = createFakeSocket();
    connect(socket);
    socket.nickname = 'BOLD-003';
    socket.isAdmin = false;

    handlers['video:meeting:start']();
    await flushMicrotasks();

    expect(sendVideoMeetingStartedAlertMock).not.toHaveBeenCalled();
    expect(getUserEmailRecipientsMock).not.toHaveBeenCalled();
  });
});
