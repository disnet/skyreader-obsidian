# Skyreader for Obsidian

Keep your [Skyreader](https://skyreader.app) highlights and notes in your vault: one note per
article, with its link, author, dates, and DOI or arXiv id, kept up to date as you read.

1. In Skyreader, open **Settings → Notes & references** and create a password for Obsidian.
2. Paste it into this plugin's settings.
3. Choose what to sync: everything you highlight, or every save in the Shelf collections you pick.

Skyreader updates only the part of each note between its two markers. Write your own notes above
or below them. Syncing is part of the Skyreader Supporter plan.

See the [guide](https://docs.skyreader.app/guide/notes-and-reference-managers/).

## Development

```bash
npm ci
npm test
npm run build   # dist/main.js and dist/manifest.json
```

To try a build, copy `dist/main.js` and `dist/manifest.json` into
`<vault>/.obsidian/plugins/skyreader/` and turn the plugin on in Obsidian's settings.

Licensed under the AGPL-3.0, like Skyreader.
