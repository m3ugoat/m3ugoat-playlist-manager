import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearSessionToken, type Device, type UserListEntry } from '../apiClient';
import { useStore, contrastText, notifyError } from '../store';
import { useAuth } from '../contexts/AuthContext';
import {
  Smartphone, Users, Trash2, Copy, Check, Plus, ShieldCheck, X, LogOut,
} from 'lucide-react';

/**
 * Signed-in devices, and — for admins — the account list.
 *
 * Both sections render nothing when no account exists, since there is no
 * identity to manage: a fresh single-user install has authentication disabled
 * entirely and this UI would only be confusing.
 */

const section =
  'bg-white dark:bg-[#1e1e1e] amoled:dark:bg-[#0a0a0a] rounded-lg elev-1 overflow-hidden';
const sectionHeader =
  'flex items-center gap-3 px-5 py-4 border-b border-gray-100 dark:border-white/8';
const inputClass =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm ' +
  'focus:outline-none bg-transparent text-gray-900 dark:text-white placeholder-gray-400';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function AccountSettings() {
  const { accentColor } = useStore();
  const navigate = useNavigate();
  const { user, authDisabled, loading: authLoading, refresh: refreshAuth, logOut } = useAuth();

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [users, setUsers] = useState<UserListEntry[] | null>(null);
  const [error, setError] = useState('');

  // New-account form
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issuedKey, setIssuedKey] = useState<{ username: string; recoveryKey: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await api.getDevices());
    } catch (e) {
      console.error(e);
      setDevices([]);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    if (!user?.isAdmin) return;
    try {
      setUsers(await api.getUsers());
    } catch (e) {
      console.error(e);
      setUsers([]);
    }
  }, [user?.isAdmin]);

  useEffect(() => {
    if (authDisabled || authLoading) return;
    loadDevices();
    loadUsers();
  }, [authDisabled, authLoading, loadDevices, loadUsers]);

  // Nothing to manage when authentication is off.
  if (authLoading || authDisabled || !user) return null;

  const revoke = async (device: Device) => {
    const label = device.current ? 'this device' : `"${device.name}"`;
    if (!window.confirm(
      `Sign out ${label}?\n\n` +
      (device.current
        ? 'You will be returned to the lock screen.'
        : 'That device will need to sign in again. Anything using its token stops working immediately.'),
    )) return;
    try {
      await api.revokeDevice(device.id);
      // Revoking your own device invalidates the token this page is using, so
      // the next request 401s and App.tsx shows the lock screen. Nothing else
      // to do here.
      if (!device.current) loadDevices();
    } catch (e) {
      console.error(e);
      notifyError(e, 'Failed to sign that device out.');
    }
  };

  /**
   * Signs out and returns to the lock screen — which is also how you switch to
   * a different account, since the lock screen is where credentials are entered.
   *
   * Navigates away from /settings first, so that signing back in lands on the
   * playlists page rather than dropping straight back into settings, then fires
   * `auth-expired` — the event App.tsx listens to in order to show the lock
   * screen.
   */
  const signOut = async () => {
    try {
      await logOut();
    } catch (e) {
      // The token may already be dead server-side; clearing it locally is what
      // actually matters, so carry on rather than trapping the user in.
      console.error(e);
    }
    clearSessionToken();
    navigate('/playlists');
    window.dispatchEvent(new Event('auth-expired'));
  };

  const createUser = async () => {
    setError('');
    if (!newUsername.trim()) return setError('Username required');
    if (newPassword.length < 4) return setError('Password must be at least 4 characters');
    setCreating(true);
    try {
      const res = await api.createUser(newUsername.trim(), newPassword, newIsAdmin);
      if (!res.ok) {
        setError(res.error || 'Could not create that account');
        return;
      }
      // The recovery key is shown once and never retrievable, so surface it
      // prominently rather than in a toast that can be missed.
      setIssuedKey({ username: res.user.username, recoveryKey: res.recoveryKey });
      setShowNewUser(false);
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
      loadUsers();
      refreshAuth();
    } catch (e) {
      console.error(e);
      setError('Connection error');
    } finally {
      setCreating(false);
    }
  };

  const deleteUser = async (target: UserListEntry) => {
    if (!window.confirm(
      `Delete the account "${target.username}"?\n\n` +
      'Its devices are signed out immediately. Its playlists are NOT deleted — they stay in ' +
      'the database but become unreachable through the UI.',
    )) return;
    try {
      const res = await api.deleteUser(target.id);
      if (!res.ok) {
        setError(res.error || 'Could not delete that account');
        return;
      }
      loadUsers();
      refreshAuth();
    } catch (e) {
      console.error(e);
      notifyError(e, 'Failed to delete that account.');
    }
  };

  const copyKey = async () => {
    if (!issuedKey) return;
    try {
      await navigator.clipboard.writeText(issuedKey.recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <>
      {/* ── Devices ──────────────────────────────────────────────────────── */}
      <section className={section}>
        <div className={sectionHeader}>
          <Smartphone className="h-5 w-5" style={{ color: accentColor }} />
          <h2 className="text-base font-medium text-gray-900 dark:text-white">Signed-in devices</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Signed in as <span className="font-medium text-gray-700 dark:text-gray-200">{user.username}</span>
            {user.isAdmin && ' (admin)'}. Sessions survive a server restart, so sign out any device you no longer have.
          </p>

          {devices === null ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-gray-400">No devices listed.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-white/8">
              {devices.map(d => (
                <li key={d.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 dark:text-white truncate">
                      {d.name}
                      {d.current && (
                        <span
                          className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium align-middle"
                          style={{ backgroundColor: accentColor, color: contrastText(accentColor) }}
                        >
                          THIS DEVICE
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Last used {relativeTime(d.lastSeenAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(d)}
                    className="md-btn shrink-0 p-1.5 rounded-full text-gray-400 hover:text-red-500 transition-colors"
                    title={d.current ? 'Sign out this device' : `Sign out ${d.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={signOut}
            className="md-btn w-full flex items-center justify-center gap-2 px-3 py-2 mt-1 rounded-lg text-sm font-medium
                       text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-white/6
                       border border-gray-200 dark:border-white/10
                       hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
            To use a different account, sign out and sign in as them.
          </p>
        </div>
      </section>

      {/* ── Accounts (admin only) ────────────────────────────────────────── */}
      {user.isAdmin && (
        <section className={section}>
          <div className={sectionHeader}>
            <Users className="h-5 w-5" style={{ color: accentColor }} />
            <h2 className="text-base font-medium text-gray-900 dark:text-white">Accounts</h2>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Each account has its own playlists, EPG sources and channel-pool sources. Accounts
              cannot see each other's data. Once a second account exists, signing in requires a
              username.
            </p>

            {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

            {issuedKey && (
              <div className="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    Recovery key for “{issuedKey.username}” — shown once. Save it now.
                  </p>
                  <button
                    onClick={() => setIssuedKey(null)}
                    className="md-btn shrink-0 p-0.5 rounded-full text-amber-700 dark:text-amber-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-xs font-mono break-all text-amber-900 dark:text-amber-200">
                    {issuedKey.recoveryKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className="md-btn shrink-0 p-1.5 rounded-full text-amber-700 dark:text-amber-300"
                    title="Copy recovery key"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {users === null ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-white/8">
                {users.map(u => (
                  <li key={u.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                        {u.username}
                        {u.isAdmin && <ShieldCheck className="h-3.5 w-3.5" style={{ color: accentColor }} title="Admin" />}
                        {u.id === user.id && <span className="text-xs text-gray-400">(you)</span>}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {u.deviceCount} {u.deviceCount === 1 ? 'device' : 'devices'}
                      </p>
                    </div>
                    {/* You cannot delete yourself, and the last account cannot be
                        removed here — use "remove password" above for that. */}
                    {u.id !== user.id && users.length > 1 && (
                      <button
                        onClick={() => deleteUser(u)}
                        className="md-btn shrink-0 p-1.5 rounded-full text-gray-400 hover:text-red-500 transition-colors"
                        title={`Delete ${u.username}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {showNewUser ? (
              <div className="space-y-2 pt-1">
                <input
                  className={inputClass}
                  placeholder="Username"
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  onFocus={e => (e.target.style.borderColor = accentColor)}
                  onBlur={e => (e.target.style.borderColor = '')}
                  autoFocus
                />
                <input
                  className={inputClass}
                  type="password"
                  placeholder="Password (min 4 characters)"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createUser()}
                  onFocus={e => (e.target.style.borderColor = accentColor)}
                  onBlur={e => (e.target.style.borderColor = '')}
                />
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={newIsAdmin}
                    onChange={e => setNewIsAdmin(e.target.checked)}
                    style={{ accentColor }}
                  />
                  Administrator (can manage accounts)
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={createUser}
                    disabled={creating}
                    className="md-btn flex-1 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                    style={{ backgroundColor: accentColor, color: contrastText(accentColor) }}
                  >
                    {creating ? 'Creating…' : 'Create account'}
                  </button>
                  <button
                    onClick={() => { setShowNewUser(false); setError(''); }}
                    className="md-btn px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300
                               border border-gray-200 dark:border-white/10"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setShowNewUser(true); setError(''); }}
                className="md-btn flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium
                           text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-white/6
                           border border-gray-200 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-white/10"
              >
                <Plus className="h-4 w-4" />
                Add account
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
