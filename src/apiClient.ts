import { useEffect, useState, useCallback } from 'react';
import { notifyError, AuthExpiredError } from './store';

// ── Session token management ────────────────────────────────────────
const SESSION_KEY = 'm3u4me-session-token';

export function getSessionToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

export function setSessionToken(token: string) {
  sessionStorage.setItem(SESSION_KEY, token);
  // AuthContext reads identity once on mount, which happens while the lock
  // screen is up and /api/auth/me still 401s. Every path that establishes a
  // session goes through here, so this is the one place that reliably tells it
  // to re-read — mirroring the existing `auth-expired` event in the other
  // direction.
  window.dispatchEvent(new Event('auth-changed'));
}

export function clearSessionToken() {
  sessionStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event('auth-changed'));
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

/** Pulls the `{ error }` message out of a failed JSON response, falling back to a generic one. */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.clone().json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // Response body wasn't JSON — fall through to the generic message below.
  }
  return `Request failed (${res.status})`;
}

/**
 * Wraps fetch to inject auth token, handle 401s globally, and throw on non-2xx responses so
 * failures actually reach callers' catch blocks instead of being treated as success. The
 * /api/auth/ endpoints are exempted since their callers inspect `ok`/`status` themselves to
 * show inline form errors (wrong password, etc.) rather than a generic failure.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(options.headers as Record<string, string> || {}) };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    clearSessionToken();
    window.dispatchEvent(new Event('auth-expired'));
    throw new AuthExpiredError(await extractErrorMessage(res));
  }
  if (!res.ok && !url.includes('/api/auth/')) {
    throw new Error(await extractErrorMessage(res));
  }
  return res;
}

export interface Playlist {
  id: string;
  name: string;
  userId: string;
  categories: string[];
  exportId: string;
  shortId: number;
  /** Secret for the public /e/:token export URLs. Rotatable. */
  exportToken: string;
  /** Bumped on every write; send back as If-Match. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AuthStatus {
  enabled: boolean;
  userCount: number;
  /** True once a second account exists, at which point login needs a username. */
  multiUser: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** True for the browser making the request. */
  current?: boolean;
}

export interface UserListEntry {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  deviceCount: number;
}

export interface Channel {
  id: string;
  playlistId: string;
  name: string;
  url: string;
  logo: string | null;
  tvgId: string | null;
  category: string;
  order: number;
  isHidden?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EpgSource {
  id: string;
  name: string;
  url: string;
  type: 'xml' | 'xtream';
  xtreamCredentials?: {
    username: string;
    password: string;
  };
  refreshIntervalHours: number;
  lastFetched: number | null;
  lastFetchError: string | null;
  channelCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface EpgChannel {
  id: string;
  displayName: string;
  icon: string | null;
  sourceId: string;
  sourceName: string;
}

export interface EpgProgramme {
  channel: string;
  title: string;
  desc: string | null;
  start: string;
  stop: string;
  category: string | null;
  date: string | null;
  episodeNum: string | null;
  subTitle: string | null;
  icon: string | null;
  rating: string | null;
  [key: string]: any;
}

export interface ChannelPoolSource {
  id: string;
  name: string;
  type: 'xtream' | 'playlist-url' | 'playlist-file';
  url: string | null;
  xtreamCredentials?: { username: string; password: string };
  refreshIntervalHours: number;
  lastFetched: number | null;
  lastFetchError: string | null;
  channelCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelPoolEntry {
  id: string;
  sourceId: string;
  name: string;
  url: string;
  logo: string | null;
  category: string;
  tvgId: string | null;
}

export interface ChannelPoolChangeLog {
  id: string;
  sourceId: string;
  sourceName: string;
  timestamp: number;
  added: { name: string; category: string }[];
  removed: { name: string; category: string }[];
  renamed: { oldName: string; newName: string; category: string }[];
}

/** One hit from /api/search — a channel from a playlist, channel pool source, or EPG
 * source. `containerId`/`containerName` point at whichever playlist/source it belongs
 * to; `category` is null for `epg` results since EPG channels aren't categorized. */
export interface SearchResult {
  kind: 'playlist' | 'channelPool' | 'epg';
  id: string;
  containerId: string;
  containerName: string;
  category: string | null;
  name: string;
  url: string | null;
  tvgId: string | null;
  logo: string | null;
  isHidden?: boolean;
}

// Custom event target for triggering refetches across components
export const dbEvents = new EventTarget();
export const triggerRefresh = () => dbEvents.dispatchEvent(new Event('refresh'));
export const epgEvents = new EventTarget();
export const triggerEpgRefresh = () => epgEvents.dispatchEvent(new Event('refresh'));
export const channelPoolEvents = new EventTarget();
export const triggerChannelPoolRefresh = () => channelPoolEvents.dispatchEvent(new Event('refresh'));

export const api = {
  getPlaylists: () => authFetch('/api/playlists').then(r => r.json()),
  createPlaylist: (name: string) => authFetch('/api/playlists', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name}) }).then(r=>r.json()),
  importPlaylist: (data: { name: string; url?: string; content?: string; confirmWarning?: boolean }) =>
    authFetch('/api/playlists/import', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()) as Promise<Playlist | { warning: string } | { error: string }>,
  updatePlaylist: (playlistId: string, updates: any) => authFetch(`/api/playlists/${playlistId}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(updates) }),
  deletePlaylist: (playlistId: string) => authFetch(`/api/playlists/${playlistId}`, { method: 'DELETE' }),
  getChannels: (playlistId: string) => authFetch(`/api/playlists/${playlistId}/channels`).then(r => r.json()),
  updateChannel: (playlistId: string, channelId: string, updates: any) => authFetch(`/api/playlists/${playlistId}/channels/${channelId}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(updates) }),
  deleteChannel: (playlistId: string, channelId: string) => authFetch(`/api/playlists/${playlistId}/channels/${channelId}`, { method: 'DELETE' }),
  bulkAddChannels: (playlistId: string, channels: any[]) => authFetch(`/api/playlists/${playlistId}/channels/bulk`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({channels}) }),
  bulkUpdateChannels: (playlistId: string, ids: string[], updates: any) => authFetch(`/api/playlists/${playlistId}/channels/bulk-update`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ids, updates}) }),
  bulkUpdateManyChannels: (playlistId: string, updates: { id: string, changes: any }[]) => authFetch(`/api/playlists/${playlistId}/channels/bulk-update-many`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({updates}) }),
  bulkDeleteChannels: (playlistId: string, ids: string[]) => authFetch(`/api/playlists/${playlistId}/channels/bulk-delete`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ids}) }),
  reorderChannels: (playlistId: string, orders: Record<string, number>) => authFetch(`/api/playlists/${playlistId}/channels/reorder`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({orders}) }),
  search: (q: string) => authFetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json()) as Promise<SearchResult[]>,
  healthCheck: (channels: { id: string; url: string }[]) =>
    authFetch('/api/health-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channels }) }).then(r => r.json()),
  bulkReplace: (playlistId: string, search: string, replace: string, field: string, ids?: string[]) =>
    authFetch(`/api/playlists/${playlistId}/channels/bulk-replace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search, replace, field, ...(ids ? { ids } : {}) }) }).then(r => r.json()),

  // Auth
  getAuthStatus: () => fetch('/api/auth/status').then(r => r.json()) as Promise<AuthStatus>,
  // `username` is optional while only one account exists — the server falls back
  // to it — and required once there are two. `deviceName` names this browser in
  // the device list so it can be revoked individually.
  login: (password: string, username?: string, deviceName?: string) =>
    fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password, username, deviceName }) }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),
  setPassword: (password: string, currentPassword?: string, username?: string) => authFetch('/api/auth/set-password', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password, currentPassword, username }) }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),
  recover: (recoveryKey: string, newPassword: string, username?: string) => fetch('/api/auth/recover', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ recoveryKey, newPassword, username }) }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),
  removePassword: (currentPassword: string) => authFetch('/api/auth/remove-password', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ currentPassword }) }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),
  logout: () => authFetch('/api/auth/logout', { method: 'POST' }),
  getCurrentUser: () => authFetch('/api/auth/me').then(r => r.json()) as Promise<{ user: AuthUser | null; device: { id: string; name: string } | null; authDisabled?: boolean }>,

  // Devices
  getDevices: () => authFetch('/api/auth/devices').then(r => r.json()) as Promise<Device[]>,
  revokeDevice: (id: string) => authFetch(`/api/auth/devices/${id}`, { method: 'DELETE' }).then(r => r.json()),

  // Users (admin only)
  getUsers: () => authFetch('/api/users').then(r => r.json()) as Promise<UserListEntry[]>,
  createUser: (username: string, password: string, isAdmin = false) =>
    authFetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password, isAdmin }) }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),
  deleteUser: (id: string) => authFetch(`/api/users/${id}`, { method: 'DELETE' }).then(r => r.json().then(data => ({ ...data, ok: r.ok, status: r.status }))),

  // Export links
  rotateExportToken: (playlistId: string) =>
    authFetch(`/api/playlists/${playlistId}/rotate-export-token`, { method: 'POST' }).then(r => r.json()) as Promise<{ exportToken: string }>,

  // EPG Sources
  getEpgSources: () => authFetch('/api/epg-sources').then(r => r.json()) as Promise<EpgSource[]>,
  createEpgSource: (data: { name: string; url: string; type: 'xml' | 'xtream'; xtreamCredentials?: { username: string; password: string }; refreshIntervalHours?: number }) =>
    authFetch('/api/epg-sources', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()) as Promise<EpgSource>,
  updateEpgSource: (id: string, updates: Partial<EpgSource>) =>
    authFetch(`/api/epg-sources/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(updates) }).then(r => r.json()),
  deleteEpgSource: (id: string) => authFetch(`/api/epg-sources/${id}`, { method: 'DELETE' }),
  refreshEpgSource: (id: string) =>
    authFetch(`/api/epg-sources/${id}/refresh`, { method: 'POST' }).then(r => r.json()),
  getEpgChannels: (sourceId: string) =>
    authFetch(`/api/epg-sources/${sourceId}/channels`).then(r => r.json()) as Promise<EpgChannel[]>,
  getEpgPrograms: (sourceId: string, channelId: string) =>
    authFetch(`/api/epg-sources/${sourceId}/programs/${encodeURIComponent(channelId)}`).then(r => r.json()) as Promise<EpgProgramme[]>,
  searchTvgIds: (query: string) =>
    authFetch(`/api/epg/tvg-ids?q=${encodeURIComponent(query)}`).then(r => r.json()) as Promise<EpgChannel[]>,
  resolveTvgIds: (ids: string[]) =>
    authFetch('/api/epg/resolve-tvg-ids', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ ids }) }).then(r => r.json()) as Promise<Record<string, { displayName: string; sourceName: string }>>,
  getEpgNow: (sourceId: string) =>
    authFetch(`/api/epg-sources/${sourceId}/now`).then(r => r.json()) as Promise<{ channels: EpgChannel[]; programmes: Record<string, EpgProgramme[]> }>,

  // Channel Pool Sources
  getChannelPoolSources: () => authFetch('/api/channel-pool/sources').then(r => r.json()) as Promise<ChannelPoolSource[]>,
  validateChannelPoolSourceUrl: (url: string) => 
    authFetch('/api/channel-pool/validate-url', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ url }) }).then(r => r.json()) as Promise<{ warning: string | null }>,
  createChannelPoolSource: (data: { name: string; type: 'xtream' | 'playlist-url' | 'playlist-file'; url?: string; xtreamCredentials?: { username: string; password: string }; refreshIntervalHours?: number }) =>
    authFetch('/api/channel-pool/sources', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()) as Promise<ChannelPoolSource>,
  updateChannelPoolSource: (id: string, updates: Partial<ChannelPoolSource>) =>
    authFetch(`/api/channel-pool/sources/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(updates) }).then(r => r.json()),
  deleteChannelPoolSource: (id: string) => authFetch(`/api/channel-pool/sources/${id}`, { method: 'DELETE' }),
  refreshChannelPoolSource: (id: string) =>
    authFetch(`/api/channel-pool/sources/${id}/refresh`, { method: 'POST' }).then(r => r.json()) as Promise<{ success: boolean; channelCount: number; changed: boolean }>,
  getChannelPoolChannels: (sourceId: string, search?: string, category?: string, sort?: 'name' | 'original') => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (category) params.set('category', category);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    return authFetch(`/api/channel-pool/sources/${sourceId}/channels${qs ? '?' + qs : ''}`).then(r => r.json()) as Promise<ChannelPoolEntry[]>;
  },
  getChannelPoolCategories: (sourceId: string) =>
    authFetch(`/api/channel-pool/sources/${sourceId}/categories`).then(r => r.json()) as Promise<string[]>,
  getChannelPoolChangelog: (page?: number) =>
    authFetch(`/api/channel-pool/changelog${page ? '?page=' + page : ''}`).then(r => r.json()) as Promise<{ logs: ChannelPoolChangeLog[]; hasMore: boolean }>,
  uploadChannelPoolSource: (data: { name: string; content: string; filename: string }) =>
    authFetch('/api/channel-pool/sources/upload', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()) as Promise<ChannelPoolSource>,
};

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPl = useCallback(async () => {
    try {
      const data = await api.getPlaylists();
      setPlaylists(data);
      setError(null);
    } catch (e) {
      console.error(e);
      setError('Failed to load playlists.');
      notifyError(e, 'Failed to load playlists.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPl();
    dbEvents.addEventListener('refresh', fetchPl);
    return () => dbEvents.removeEventListener('refresh', fetchPl);
  }, [fetchPl]);

  return { playlists, loading, error, refetch: fetchPl };
}

// Stable placeholder so the "wrong playlist" branch below always returns the *same* array
// reference. Returning a fresh `[]` on every call (as this used to) makes the hook's result
// change identity on every render for as long as `fetchedFor !== playlistId` (i.e. the whole
// time a fetch is in flight) — any effect depending on `channels` then re-fires on every
// render too, and if that effect unconditionally calls setState (as the tvg-id resolution
// effect in PlaylistEditor did), the new state triggers another render, which produces
// another fresh `[]`, forever — a tight render loop that trips React's "Maximum update depth
// exceeded" guard.
const EMPTY_CHANNELS: Channel[] = [];

export function useChannels(playlistId: string | null) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCh = useCallback(async () => {
    if (!playlistId) {
      setChannels([]);
      setFetchedFor(null);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const data = await api.getChannels(playlistId);
      setChannels(data);
      setFetchedFor(playlistId);
      setError(null);
    } catch (e) {
      console.error(e);
      setError('Failed to load channels.');
      notifyError(e, 'Failed to load channels.');
    } finally {
      setLoading(false);
    }
  }, [playlistId]);

  useEffect(() => {
    fetchCh();
    dbEvents.addEventListener('refresh', fetchCh);
    return () => dbEvents.removeEventListener('refresh', fetchCh);
  }, [fetchCh]);

  // Return empty channels synchronously when the fetched data is for a different playlist,
  // preventing stale channels from contaminating computations in the new playlist's context.
  return { channels: fetchedFor === playlistId ? channels : EMPTY_CHANNELS, loading, error, refetch: fetchCh };
}

export function useEpgSources() {
  const [sources, setSources] = useState<EpgSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const data = await api.getEpgSources();
      setSources(data);
      setError(null);
    } catch (e) {
      console.error(e);
      setError('Failed to load EPG sources.');
      notifyError(e, 'Failed to load EPG sources.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
    epgEvents.addEventListener('refresh', fetchSources);
    dbEvents.addEventListener('refresh', fetchSources);
    return () => {
      epgEvents.removeEventListener('refresh', fetchSources);
      dbEvents.removeEventListener('refresh', fetchSources);
    };
  }, [fetchSources]);

  return { sources, loading, error, refetch: fetchSources };
}

export function useChannelPoolSources() {
  const [sources, setSources] = useState<ChannelPoolSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const data = await api.getChannelPoolSources();
      setSources(data);
      setError(null);
    } catch (e) {
      console.error(e);
      setError('Failed to load channel sources.');
      notifyError(e, 'Failed to load channel sources.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
    channelPoolEvents.addEventListener('refresh', fetchSources);
    dbEvents.addEventListener('refresh', fetchSources);
    return () => {
      channelPoolEvents.removeEventListener('refresh', fetchSources);
      dbEvents.removeEventListener('refresh', fetchSources);
    };
  }, [fetchSources]);

  return { sources, loading, error, refetch: fetchSources };
}
