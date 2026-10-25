// One sync: fetch what changed since the last cursor, then write each page's
// note. Written against small interfaces (NoteStore, fetch) so the logic is
// tested without Obsidian; main.ts adapts the vault and requestUrl to them.

import { frontmatterFor, noteName, renderRegion, replaceRegion, type SyncSource } from './render';

export interface NoteStore {
  /** The note's text, or null when there's no file at the path. */
  read(path: string): Promise<string | null>;
  exists(path: string): boolean;
  create(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  /** Set these frontmatter properties (undefined removes one), keeping the rest. */
  setFrontmatter(path: string, fields: Record<string, string | undefined>): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export interface SyncSettings {
  serverUrl: string;
  appPassword: string;
  folder: string;
  /** Everything highlighted, or every save in the chosen Shelf collections. */
  scope: 'everything' | 'collections';
  collections: string[];
}

export interface SyncState {
  /** The cursor the last sync returned, for the scope it was made with. */
  cursor: number;
  /** The scope the cursor belongs to; a different one starts over. */
  scopeKey: string;
  /** Every key a page goes by → its note's path. */
  notes: Record<string, string>;
}

export const emptyState = (): SyncState => ({ cursor: 0, scopeKey: '', notes: {} });

export interface SyncResult {
  created: number;
  updated: number;
  /** Pages whose note couldn't be written (a name the disk refuses, say). */
  failed: number;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export type Fetch = (
  url: string,
  headers: Record<string, string>
) => Promise<{ status: number; json: unknown }>;

export function scopeKey(settings: SyncSettings): string {
  return settings.scope === 'collections'
    ? `collections:${[...settings.collections].sort().join(',')}`
    : 'everything';
}

export function syncUrl(settings: SyncSettings, since: number, path = ''): string {
  const base = settings.serverUrl.trim().replace(/\/+$/, '');
  const params = new URLSearchParams({ since: String(since) });
  if (settings.scope === 'collections') {
    for (const id of settings.collections) params.append('collection', id);
  }
  return `${base}/api/highlights/sync${path}${path ? '' : `?${params}`}`;
}

function failure(status: number, body: unknown): SyncError {
  if (status === 401) {
    return new SyncError('Skyreader refused the app password. Make a new one in Settings.', 401);
  }
  if (status === 403) {
    return new SyncError('Highlight sync is part of the Supporter plan.', 403);
  }
  if (status === 429) return new SyncError('Skyreader asked to slow down. Try again soon.', 429);
  const message = (body as { error?: unknown } | null)?.error;
  return new SyncError(
    typeof message === 'string' ? message : `Skyreader answered ${status}.`,
    status
  );
}

async function get(fetch: Fetch, settings: SyncSettings, url: string): Promise<unknown> {
  if (!settings.appPassword.trim()) throw new SyncError('Add a Skyreader app password first.');
  const response = await fetch(url, { Authorization: `Bearer ${settings.appPassword.trim()}` });
  if (response.status !== 200) throw failure(response.status, response.json);
  return response.json;
}

export async function listCollections(
  fetch: Fetch,
  settings: SyncSettings
): Promise<{ id: string; name: string }[]> {
  const body = (await get(fetch, settings, syncUrl(settings, 0, '/collections'))) as {
    collections?: { id: string; name: string }[];
  };
  return body.collections ?? [];
}

function folderPath(settings: SyncSettings): string {
  return settings.folder.trim().replace(/^\/+|\/+$/g, '') || 'Skyreader';
}

// A free path for a new note: its name, then "name 2", "name 3", …
function freePath(store: NoteStore, folder: string, name: string): string {
  for (let n = 1; ; n++) {
    const path = `${folder}/${n === 1 ? name : `${name} ${n}`}.md`;
    if (!store.exists(path)) return path;
  }
}

/**
 * Write one page's note: update the synced part of the note it already has,
 * or make one. A note is made only for a page with something to show, so a
 * page whose highlights were all deleted doesn't leave an empty note behind.
 */
async function applySource(
  store: NoteStore,
  state: SyncState,
  settings: SyncSettings,
  source: SyncSource,
  result: SyncResult
): Promise<void> {
  const keys = source.keys?.length ? source.keys : source.id ? [source.id] : [];
  if (keys.length === 0) return;
  const known = keys.map((k) => state.notes[k]).find((p) => p && store.exists(p));
  const region = renderRegion(source);
  let path = known;
  if (path) {
    const content = (await store.read(path)) ?? '';
    const next = replaceRegion(content, region);
    if (next !== content) {
      await store.write(path, next);
      await store.setFrontmatter(path, frontmatterFor(source));
      result.updated++;
    }
  } else {
    if (source.highlights.length === 0 && settings.scope !== 'collections') return;
    const folder = folderPath(settings);
    await store.ensureFolder(folder);
    path = freePath(store, folder, noteName(source));
    await store.create(path, `${region}\n`);
    await store.setFrontmatter(path, frontmatterFor(source));
    result.created++;
  }
  for (const key of keys) state.notes[key] = path;
}

/**
 * Fetch the pages that changed since the last sync and write their notes.
 * The state is changed in place; save it after, whether this throws or not:
 * the notes already written are recorded in it.
 */
export async function runSync(
  fetch: Fetch,
  store: NoteStore,
  settings: SyncSettings,
  state: SyncState
): Promise<SyncResult> {
  const key = scopeKey(settings);
  if (state.scopeKey !== key) {
    state.cursor = 0;
    state.scopeKey = key;
  }
  if (settings.scope === 'collections' && settings.collections.length === 0) {
    throw new SyncError('Choose at least one collection to sync.');
  }
  const body = (await get(fetch, settings, syncUrl(settings, state.cursor))) as {
    cursor?: unknown;
    sources?: unknown;
  };
  if (typeof body?.cursor !== 'number' || !Array.isArray(body.sources)) {
    throw new SyncError('Skyreader sent an answer this plugin doesn’t understand.');
  }
  const result: SyncResult = { created: 0, updated: 0, failed: 0 };
  for (const source of body.sources as SyncSource[]) {
    // One page that can't be written mustn't hold the rest back every sync;
    // it's written again the next time it changes.
    try {
      await applySource(store, state, settings, source, result);
    } catch (err) {
      console.error('[skyreader] could not write a note', source.id, err);
      result.failed++;
    }
  }
  state.cursor = body.cursor;
  return result;
}
