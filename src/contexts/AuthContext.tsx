import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, type AuthUser } from '../apiClient';

/**
 * The signed-in account, for components that need to branch on identity —
 * chiefly to show or hide admin-only UI.
 *
 * This used to be a stub returning a hardcoded dummy user with no connection to
 * the real password system. It is now backed by `GET /api/auth/me`.
 *
 * `authDisabled` is the case where no account has been created at all: the API
 * is open, `user` is null, and the UI should behave as a single-user app rather
 * than prompting anyone to sign in. Distinguish that from "signed out" — a null
 * user alone does not mean a login is needed.
 */
interface AuthContextType {
  user: AuthUser | null;
  /** The device row for this browser, when signed in. */
  device: { id: string; name: string } | null;
  /** True when no account exists, so no login is required. */
  authDisabled: boolean;
  loading: boolean;
  /** Re-reads identity, e.g. after signing in or changing a password. */
  refresh: () => Promise<void>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  device: null,
  authDisabled: true,
  loading: true,
  refresh: async () => {},
  logOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [device, setDevice] = useState<{ id: string; name: string } | null>(null);
  const [authDisabled, setAuthDisabled] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await api.getCurrentUser();
      setUser(me.user ?? null);
      setDevice(me.device ?? null);
      setAuthDisabled(!!me.authDisabled);
    } catch {
      // A 401 here is normal before signing in; App.tsx drives the lock screen
      // off the `auth-expired` event, so this only needs to avoid throwing.
      setUser(null);
      setDevice(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // A session ending clears identity; a session starting (or being replaced,
    // e.g. after a password change re-issues a token) needs a re-read, since
    // the initial refresh above ran while the lock screen was still up.
    const onExpired = () => {
      setUser(null);
      setDevice(null);
    };
    window.addEventListener('auth-expired', onExpired);
    window.addEventListener('auth-changed', refresh);
    return () => {
      window.removeEventListener('auth-expired', onExpired);
      window.removeEventListener('auth-changed', refresh);
    };
  }, [refresh]);

  const logOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setDevice(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, device, authDisabled, loading, refresh, logOut }}>
      {children}
    </AuthContext.Provider>
  );
};
