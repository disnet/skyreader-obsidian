# CLAUDE.md

The Skyreader plugin for Obsidian: keeps one note per article in the reader's vault, with their
highlights, notes and citation details, from Skyreader's `GET /api/highlights/sync`
(`backend/src/routes/highlight-sync.ts` in [disnet/skyreader](https://github.com/disnet/skyreader)).
Signed in with an app password, the same credential Skyreader's Google Reader API uses. A Supporter
feature there (`liveIntegrations` in `backend/src/config/tier-limits.ts`).

```bash
npm ci          # .npmrc sets legacy-peer-deps: obsidian pins CodeMirror peers npm can't resolve
npm test        # vitest over src/render.ts and src/sync.ts
npm run check   # tsc and prettier
npm run build   # tsc, then esbuild → dist/main.js + dist/manifest.json (what a vault installs)
```

## Layout

- `src/render.ts`: pure. The synced region of a note, its frontmatter, its file name.
- `src/sync.ts`: pure. One sync over a `NoteStore` and a `Fetch`, so it's tested without Obsidian.
- `src/main.ts`: the only file that imports `obsidian`. Adapts the vault and `requestUrl` (which
  isn't bound by CORS, so the backend needs no allowance) and holds the settings tab.

The response shape (`SyncSource` in `src/render.ts`) mirrors `ExportSource` in the backend's
`services/export/render.ts`. A change to one is a change to both.

## Rules

- **The reader's writing is theirs.** A sync rewrites only the region between `%% skyreader:start`
  and `%% skyreader:end %%`, and only the frontmatter keys `frontmatterFor` names. Anything else in
  a note is never touched.
- **A page is found by any of its keys** (`source.keys`): a page highlighted, then saved, is one
  note. The state maps every key to a path, and a vault rename updates it.
- **A scope change starts over** (cursor back to 0), since the cursor belongs to one scope.
- The server sends each changed page whole, and the cursor trails the request by a minute, so a
  page can arrive twice; a sync writes only when the region's text changed.
- **One page that can't be written never stalls the rest**: it's counted, logged, and skipped.

## Releasing

Obsidian installs from a GitHub release tagged exactly with the version (no `v`), with `main.js`
and `manifest.json` attached. Bump `version` in `manifest.json` and `package.json`, add the version
to `versions.json` (version → minimum Obsidian version), merge, then push the tag:
`git tag 0.1.0 && git push origin 0.1.0`. `.github/workflows/release.yml` builds and publishes it.
