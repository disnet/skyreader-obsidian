import { describe, expect, it } from 'vitest';
import {
  frontmatterFor,
  mdText,
  noteName,
  REGION_END,
  renderRegion,
  replaceRegion,
  type SyncSource,
} from '../src/render';
import {
  emptyState,
  runSync,
  syncUrl,
  type Fetch,
  type NoteStore,
  type SyncSettings,
} from '../src/sync';

const paper: SyncSource = {
  kind: 'save',
  id: 'saved:3abc',
  keys: ['saved:3abc', 'guid-1'],
  title: 'Attention Is All You Need',
  url: 'https://arxiv.org/abs/1706.03762',
  author: 'Ashish Vaswani',
  publishedAt: '2017-06-12T00:00:00.000Z',
  savedAt: '2026-10-01T10:00:00.000Z',
  doi: '10.48550/arXiv.1706.03762',
  arxivId: '1706.03762',
  highlights: [
    { id: 'h1', text: 'The Transformer #1 uses %% attention', note: 'Key [[idea]]' },
    { id: 'h2', text: 'second\n\nparagraph' },
  ],
};

describe('render', () => {
  it('writes the synced part with citation details and escaped highlights', () => {
    const region = renderRegion(paper);
    expect(region.split('\n')[0]).toMatch(/^%% skyreader:start · /);
    expect(region).toContain('# Attention Is All You Need');
    expect(region).toContain(
      '- DOI: [10.48550/arXiv.1706.03762](<https://doi.org/10.48550/arXiv.1706.03762>)'
    );
    expect(region).toContain('- arXiv: [1706.03762](<https://arxiv.org/abs/1706.03762>)');
    expect(region).toContain('> The Transformer \\#1 uses \\%\\% attention');
    expect(region).toContain('**Note:** Key \\[\\[idea\\]\\]');
    expect(region).toContain('> second\n>\n> paragraph');
    expect(region.endsWith(REGION_END)).toBe(true);
  });

  it('escapes list, rule and math starts', () => {
    expect(mdText('- item\n---\n1. one\n$x$')).toBe('\\- item\n\\---\n1\\. one\n\\$x\\$');
  });

  it("replaces only the synced part, keeping the reader's writing", () => {
    const note = `---\ntags: [x]\n---\nMy intro\n\n${renderRegion({ ...paper, highlights: [] })}\n\nMy notes after`;
    const next = replaceRegion(note, renderRegion(paper));
    expect(next.startsWith('---\ntags: [x]\n---\nMy intro\n\n')).toBe(true);
    expect(next.endsWith('\n\nMy notes after')).toBe(true);
    expect(next).toContain('## Highlights');
    // Markers taken out: the synced part goes at the end.
    expect(replaceRegion('Just mine\n', 'R')).toBe('Just mine\n\nR\n');
  });

  it('names notes safely and sets citation frontmatter', () => {
    expect(noteName({ ...paper, title: 'A/B: what? #1 [draft]' })).toBe('A B what 1 draft');
    expect(
      noteName({ kind: 'highlighted', highlights: [], url: 'https://www.example.com/x' })
    ).toBe('example.com');
    expect(frontmatterFor(paper)).toMatchObject({
      doi: '10.48550/arXiv.1706.03762',
      arxiv: '1706.03762',
      published: '2017-06-12',
      skyreader_id: 'saved:3abc',
    });
  });
});

function memoryStore() {
  const files = new Map<string, string>();
  const frontmatter = new Map<string, Record<string, string | undefined>>();
  const store: NoteStore = {
    read: async (path) => files.get(path) ?? null,
    exists: (path) => files.has(path),
    create: async (path, content) => {
      if (files.has(path)) throw new Error('exists');
      files.set(path, content);
    },
    write: async (path, content) => {
      files.set(path, content);
    },
    setFrontmatter: async (path, fields) => {
      frontmatter.set(path, { ...frontmatter.get(path), ...fields });
    },
    ensureFolder: async () => {},
  };
  return { files, frontmatter, store };
}

const settings: SyncSettings = {
  serverUrl: 'https://api.example/',
  appPassword: 'abcd-efgh',
  folder: 'Reading/',
  scope: 'everything',
  collections: [],
};

function server(responses: { cursor: number; sources: SyncSource[] }[]) {
  const urls: string[] = [];
  const fetch: Fetch = async (url, headers) => {
    expect(headers.Authorization).toBe('Bearer abcd-efgh');
    urls.push(url);
    return { status: 200, json: responses.shift() };
  };
  return { fetch, urls };
}

describe('runSync', () => {
  it('makes a note per highlighted page, then updates it in place by any of its keys', async () => {
    const { files, frontmatter, store } = memoryStore();
    const state = emptyState();
    const { fetch, urls } = server([
      {
        cursor: 100,
        sources: [
          { ...paper, highlights: paper.highlights.slice(0, 1) },
          // Nothing to show and no note yet: no empty note.
          { kind: 'highlighted', id: 'guid-gone', keys: ['guid-gone'], highlights: [] },
        ],
      },
      // Saved later under a new id; the old key still finds the note.
      { cursor: 200, sources: [{ ...paper, id: 'saved:other', keys: ['saved:other', 'guid-1'] }] },
      { cursor: 300, sources: [{ ...paper, id: 'saved:other', keys: ['saved:other', 'guid-1'] }] },
    ]);

    expect(await runSync(fetch, store, settings, state)).toEqual({
      created: 1,
      updated: 0,
      failed: 0,
    });
    expect([...files.keys()]).toEqual(['Reading/Attention Is All You Need.md']);
    const path = 'Reading/Attention Is All You Need.md';
    files.set(path, `${files.get(path)}\nMy own thoughts\n`);

    expect(await runSync(fetch, store, settings, state)).toEqual({
      created: 0,
      updated: 1,
      failed: 0,
    });
    expect(files.get(path)).toContain('> second');
    expect(files.get(path)).toContain('My own thoughts');
    expect(frontmatter.get(path)?.skyreader_id).toBe('saved:other');
    // Nothing changed: nothing written.
    expect(await runSync(fetch, store, settings, state)).toEqual({
      created: 0,
      updated: 0,
      failed: 0,
    });
    expect(urls).toEqual([
      'https://api.example/api/highlights/sync?since=0',
      'https://api.example/api/highlights/sync?since=100',
      'https://api.example/api/highlights/sync?since=200',
    ]);
    expect(state.cursor).toBe(300);
  });

  it('gives same-named pages their own notes', async () => {
    const { files, store } = memoryStore();
    const { fetch } = server([
      {
        cursor: 1,
        sources: [
          { ...paper, id: 'a', keys: ['a'] },
          { ...paper, id: 'b', keys: ['b'] },
        ],
      },
    ]);
    await runSync(fetch, store, settings, emptyState());
    expect([...files.keys()]).toEqual([
      'Reading/Attention Is All You Need.md',
      'Reading/Attention Is All You Need 2.md',
    ]);
  });

  it('starts over when the scope changes, and keeps unhighlighted saves in collections', async () => {
    const { files, store } = memoryStore();
    const state = { ...emptyState(), cursor: 500, scopeKey: 'everything' };
    const scoped: SyncSettings = { ...settings, scope: 'collections', collections: ['b', 'a'] };
    const { fetch, urls } = server([{ cursor: 9, sources: [{ ...paper, highlights: [] }] }]);
    await runSync(fetch, store, scoped, state);
    expect(urls[0]).toBe(syncUrl(scoped, 0));
    expect(urls[0]).toBe(
      'https://api.example/api/highlights/sync?since=0&collection=b&collection=a'
    );
    expect(files.size).toBe(1);
    expect(state.scopeKey).toBe('collections:a,b');
  });

  it('says what to fix when the server refuses', async () => {
    const { store } = memoryStore();
    const refuse =
      (status: number): Fetch =>
      async () => ({ status, json: { error: 'nope' } });
    await expect(runSync(refuse(401), store, settings, emptyState())).rejects.toThrow(
      /app password/
    );
    await expect(runSync(refuse(403), store, settings, emptyState())).rejects.toThrow(/Supporter/);
    await expect(
      runSync(refuse(200), store, { ...settings, appPassword: ' ' }, emptyState())
    ).rejects.toThrow(/app password first/);
  });

  it('writes the other pages when one fails, and moves on', async () => {
    const { files, store } = memoryStore();
    const failing: NoteStore = {
      ...store,
      create: async (path, content) => {
        if (path.includes('CON')) throw new Error('reserved name');
        return store.create(path, content);
      },
    };
    const state = emptyState();
    const { fetch } = server([
      {
        cursor: 7,
        sources: [
          { ...paper, id: 'a', keys: ['a'], title: 'CON' },
          { ...paper, id: 'b', keys: ['b'] },
        ],
      },
    ]);
    expect(await runSync(fetch, failing, settings, state)).toEqual({
      created: 1,
      updated: 0,
      failed: 1,
    });
    expect(files.size).toBe(1);
    expect(state.cursor).toBe(7);
  });
});
