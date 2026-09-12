import { io } from 'socket.io-client';
import { getSocketBaseUrl } from './api.js';

let socket = null;
// Read by the 'connect' handler below on every (re)connection, not just the
// one that created the socket -- see the reuse comment in connectSocket().
let pendingRegistration = { nickname: null, token: null };

export function connectSocket(nickname, token = null) {
  pendingRegistration = { nickname, token };

  if (socket) {
    // Reuse the already-created socket instead of spinning up a second
    // io() instance. Multiple call sites (DashboardPage, EmergencyChatPanel,
    // GlobalVoiceAssistant) each call connectSocket() independently on
    // mount -- checking `socket?.connected` here (the previous behavior)
    // is false during the brief window before the first 'connect' event
    // fires, so a second caller landing in that window created and
    // silently orphaned a whole second connection with its own
    // reconnection loop, while the first caller's listeners stayed
    // attached to the (now effectively abandoned) original socket. Reusing
    // the instance unconditionally is always safe: socket.io queues emits
    // issued before 'connect' and reconnects on its own, so there's no
    // connected-state check to get right here. A genuinely fresh socket is
    // only ever created after an explicit disconnectSocket().
    socket.auth = { token };
    if (socket.connected) socket.emit('register', pendingRegistration);
    return socket;
  }

  socket = io(getSocketBaseUrl(), {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 2000,
    auth: { token },
    // Web has no token to pass in `auth` above (see api.js's getToken()) --
    // it authenticates the socket the same way as any other request, via
    // the httpOnly session cookie, which this makes the handshake include.
    withCredentials: true,
  });

  socket.on('connect', () => {
    socket.emit('register', pendingRegistration);
  });

  return socket;
}

export function getSocket() { return socket; }

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
