import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, isLoggedIn } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // undefined = still resolving; null = logged out; object = logged in
  const [user, setUser] = useState(undefined);

  const refresh = useCallback(async () => {
    if (!isLoggedIn()) {
      setUser(null);
      return;
    }
    try {
      const me = await api.me();
      setUser(me);
    } catch {
      setToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function login(orgSlug, email, password) {
    const { token } = await api.login(orgSlug, email, password);
    setToken(token);
    await refresh();
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  function hasPermission(permission) {
    return Boolean(user?.permissions?.includes(permission));
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { getToken };
