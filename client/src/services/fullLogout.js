import { setJWT, setLocalAuthUser, logoutRequest, clearLocalChatHistory } from './api.js';
import { disconnectSocket } from './socket.js';
import { isNativeApp, nativeAuth } from './nativeBridge.js';

// The same real logout DashboardPage's header button/voice command run --
// clears the server-side cookie, the native platform's own secure JWT
// store, in-memory auth state, per-device chat history, and the socket
// connection. Shared so anything that can trigger a logout without a user
// clicking the button (e.g. the idle-timeout guard below) does the exact
// same teardown rather than a partial one that leaves a stale socket or
// chat history behind for the next person at a shared/kiosk device.
export async function fullLogout() {
  logoutRequest();
  if (isNativeApp) nativeAuth.logoutSession().catch(() => {});
  setJWT(null);
  setLocalAuthUser(null);
  clearLocalChatHistory();
  disconnectSocket();
}
