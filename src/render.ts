// What a synced note says: the part Skyreader keeps up to date, its
// frontmatter, and its file name. Pure functions of one source from
// GET /api/highlights/sync, so they're tested without Obsidian.

export interface SyncHighlight {
  id?: string;
  text: string;
  note?: string;
  /** ISO datetime. */
  createdAt?: string;
}

/** One page, as the backend's export sends it (backend/src/services/export/render.ts). */
export interface SyncSource {
  kind: 'save' | 'highlighted';
  id?: string;
  keys?: string[];
  title?: string;
  url?: string;
  author?: string;
  domain?: string;
  publishedAt?: string;
  savedAt?: string;
  filename?: string;
  contentType?: string;
  doi?: string;
  arxivId?: string;
  highlights: SyncHighlight[];
}

// The markers around the synced part. Obsidian hides %% comments in reading
// view, so a note reads as if they weren't there.
export const REGION_START = '%% skyreader:start';
export const REGION_END = '%% skyreader:end %%';
const START_LINE = `${REGION_START} · Skyreader keeps this part up to date. Write your own notes outside it. %%`;

const day = (iso: string | undefined) => iso?.slice(0, 10);

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function displayTitle(source: SyncSource): string {
  return source.title?.trim() || source.filename || hostOf(source.url) || source.url || 'Untitled';
}

// Escapes what would change the text's structure in Obsidian: Markdown
// syntax, `#` (a tag), `$` (math), `%` (a comment, which would also swallow
// the region's end marker), and `[[`/`]]` (a wikilink).
export function mdText(text: string): string {
  return (
    text
      .replace(/[\\`*_[\]<>#$|~%=^]/g, '\\$&')
      // A line of only dashes is a rule (or underlines the line above into a
      // heading); a leading - or + starts a list, a leading "1." a numbered one.
      .replace(/^(\s*)(-)(?=[-\s]*$)/gm, '$1\\$2')
      .replace(/^(\s*)([-+])(?=\s)/gm, '$1\\$2')
      .replace(/^(\s*)(\d+)([.)])(?=\s|$)/gm, '$1$2\\$3')
  );
}

const mdLine = (text: string) => mdText(text.replace(/\s+/g, ' ').trim());

const mdUrl = (url: string) => `<${url.replace(/[<>\s]/g, encodeURIComponent)}>`;

const mdLink = (text: string, url: string) => `[${mdLine(text)}](${mdUrl(url)})`;

const doiUrl = (doi: string) =>
  `https://doi.org/${encodeURI(doi).replace(/[#?]/g, encodeURIComponent)}`;

function blockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${mdText(line.trim())}` : '>'))
    .join('\n');
}

/** The synced part of a note, markers included. */
export function renderRegion(source: SyncSource): string {
  const out = [START_LINE, `# ${mdLine(displayTitle(source))}`, ''];
  const meta: string[] = [];
  if (source.author) meta.push(`Author: ${mdLine(source.author)}`);
  if (source.url) meta.push(`Link: ${mdLink(hostOf(source.url) ?? source.url, source.url)}`);
  else if (source.filename) meta.push(`File: ${mdLine(source.filename)}`);
  if (source.doi) meta.push(`DOI: ${mdLink(source.doi, doiUrl(source.doi))}`);
  if (source.arxivId) {
    meta.push(`arXiv: ${mdLink(source.arxivId, `https://arxiv.org/abs/${source.arxivId}`)}`);
  }
  if (source.publishedAt) meta.push(`Published: ${day(source.publishedAt)}`);
  if (source.savedAt) meta.push(`Saved: ${day(source.savedAt)}`);
  out.push(...meta.map((line) => `- ${line}`));

  if (source.highlights.length > 0) out.push('', '## Highlights');
  for (const highlight of source.highlights) {
    out.push('', highlight.text.trim() ? blockquote(highlight.text) : '> …');
    if (highlight.note?.trim()) {
      const [first, ...rest] = highlight.note.trim().split('\n');
      out.push('', `**Note:** ${mdText(first)}`, ...rest.map((line) => mdText(line)));
    }
  }
  out.push('', REGION_END);
  return out.join('\n');
}

/**
 * The note with its synced part replaced, or appended when the reader took
 * the markers out. Everything outside the markers is the reader's and is kept.
 */
export function replaceRegion(content: string, region: string): string {
  const start = content.indexOf(REGION_START);
  const end = start === -1 ? -1 : content.indexOf(REGION_END, start);
  if (start === -1 || end === -1) {
    const body = content.replace(/\s*$/, '');
    return `${body ? `${body}\n\n` : ''}${region}\n`;
  }
  return content.slice(0, start) + region + content.slice(end + REGION_END.length);
}

/**
 * Frontmatter properties Skyreader sets (and updates; other properties are
 * left alone). Citation details are what a reference manager or a Dataview
 * query needs. `skyreader_id` is the page's id in Skyreader.
 */
export function frontmatterFor(source: SyncSource): Record<string, string | undefined> {
  return {
    title: displayTitle(source),
    author: source.author,
    url: source.url,
    doi: source.doi,
    arxiv: source.arxivId,
    published: day(source.publishedAt),
    saved: day(source.savedAt),
    skyreader_id: source.id,
  };
}

// Characters a file name can't hold on some platform, or that Obsidian reads
// as link syntax. Control characters go too, below.
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/** A file name (no extension) for the page's note: its title, made safe. */
export function noteName(source: SyncSource): string {
  const name = Array.from(displayTitle(source), (c) => (c < ' ' ? ' ' : c))
    .join('')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return name || 'Untitled';
}
