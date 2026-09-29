import { realFiles } from './store.ts';
import type { Project } from './types.ts';

export type ConsoleKind = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleEntry {
  kind: ConsoleKind;
  text: string;
  where?: string;
  /** Project file + line the error maps to, when it comes from inlined code. */
  target?: ErrorTarget;
  time: number;
}

/** One inlined file's content lines inside the finished preview document. */
export interface LineSegment {
  /** Project path of the inlined file. */
  file: string;
  /** 1-based first content line in the final document. */
  start: number;
  /** 1-based last content line in the final document. */
  end: number;
}

export interface BuiltPreview {
  html: string;
  lineMap: LineSegment[];
}

/** Project file + 1-based line a preview error location points at. */
export interface ErrorTarget {
  file: string;
  line: number;
}

export const PREVIEW_TAG = '__codebox';

// Runs inside the preview iframe: forwards runtime errors and console
// output to the app via postMessage. The iframe is sandboxed
// (allow-scripts only), so user code can never touch the app or storage.
const HOOK_SCRIPT = `<script>
(function () {
  function send(kind, text, where) {
    try {
      parent.postMessage({ ${PREVIEW_TAG}: 1, kind: kind, text: String(text).slice(0, 2000), where: where || "" }, "*");
    } catch (e) {}
  }
  function fmt(a) {
    if (typeof a === "string") return a;
    try {
      var s = JSON.stringify(a);
      return s === undefined ? String(a) : s.slice(0, 1000);
    } catch (e) {
      return String(a);
    }
  }
  window.addEventListener("error", function (e) {
    var file = "";
    try { file = (e.filename || "").split("/").pop(); } catch (x) {}
    send("error", e.message || "Script error", file + (e.lineno ? ":" + e.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    send("error", (r && (r.message || r)) || "Unhandled rejection", "");
  });
  ["log", "info", "warn", "error"].forEach(function (m) {
    var orig;
    try { orig = console[m].bind(console); } catch (e) { return; }
    console[m] = function () {
      send(m === "info" ? "info" : m, Array.prototype.map.call(arguments, fmt).join(" "), "");
      try { orig.apply(null, arguments); } catch (e) {}
    };
  });
})();
<\/script>`;

const EMPTY_SHELL = (name: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>body{background:#0a0a0a;color:#f4f4f4;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{border:1px solid #2a2a2a;padding:32px;max-width:420px;background:#101010}b{color:rgb(200,255,0)}</style>
</head><body><main><p><b>■ CodeBox</b></p><h1>No HTML file yet</h1><p>Create an <code>index.html</code> in project “${name}” to see it here.</p></main></body></html>`;

/** Which HTML file the preview renders. */
export function entryFor(project: Project, activePath: string | null): string | null {
  const files = realFiles(project);
  if (activePath && activePath.toLowerCase().endsWith('.html') && files.some((f) => f.path === activePath)) {
    return activePath;
  }
  const byName = (n: string) => files.find((f) => f.path.toLowerCase() === n);
  return (
    byName('index.html')?.path ??
    byName('index.htm')?.path ??
    [...files]
      .filter((f) => f.path.toLowerCase().endsWith('.html') || f.path.toLowerCase().endsWith('.htm'))
      .sort((a, b) => a.path.localeCompare(b.path))[0]?.path ??
    null
  );
}

/** External URLs, anchors and data/blob URLs are never treated as local. */
function isLocalRef(ref: string): boolean {
  const r = ref.trim();
  return (
    r !== '' &&
    !r.startsWith('#') &&
    !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(r) &&
    !r.startsWith('data:') &&
    !r.startsWith('blob:')
  );
}

/** Resolve a relative ref against the entry file's directory, clamped at root. */
function resolveRef(entryDir: string, ref: string): string {
  const [bare] = ref.split(/[?#]/);
  const parts: string[] = [...(entryDir ? entryDir.split('/') : []), ...bare.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Bundle the project into one standalone document: local stylesheets and
 * scripts are inlined so the sandboxed iframe needs no subresource origin.
 * Also returns a map of inlined file lines for error lookup.
 */
export function buildStandaloneHtml(project: Project, entryPath: string): BuiltPreview {
  const entry = project.files.find((f) => f.path === entryPath);
  const source = entry?.content ?? '';
  const byPath = new Map(realFiles(project).map((f) => [f.path, f.content]));
  const entryDir = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';

  const withCss = source.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!rel.includes('stylesheet') || !href || !isLocalRef(href)) return tag;
    const css = byPath.get(resolveRef(entryDir, href));
    if (css === undefined) return tag;
    return `<style data-codebox-src="${escapeHtml(href)}">\n${css}\n</style>`;
  });

  const withJs = withCss.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attrs: string) => {
    const src = attr(attrs, 'src');
    if (!src || !isLocalRef(src)) return tag;
    const js = byPath.get(resolveRef(entryDir, src));
    if (js === undefined) return tag;
    return `<script data-codebox-src="${escapeHtml(src)}">\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });

  const withImg = withJs.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src');
    if (!src || !isLocalRef(src)) return tag;
    const file = byPath.get(resolveRef(entryDir, src));
    if (typeof file !== 'string' || !file.startsWith('data:')) return tag;
    return tag.replace(/src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, `src="${file}"`);
  });

  const withBase = /<base\b/i.test(withImg) ? withImg : withImg.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<base target="_blank">`);
  const html = withBase.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${HOOK_SCRIPT}`);
  return { html, lineMap: buildLineMap(html, byPath) };
}

function unescapeAttr(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Locate every inlined file's content lines in the finished document. */
function buildLineMap(html: string, byPath: Map<string, string>): LineSegment[] {
  const segments: LineSegment[] = [];
  const marker = /data-codebox-src="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(html)) !== null) {
    const file = unescapeAttr(m[1]);
    const content = byPath.get(file);
    if (content === undefined) continue;
    const afterTag = html.indexOf('>', m.index);
    if (afterTag === -1) continue;
    const newline = html.indexOf('\n', afterTag);
    if (newline === -1) continue;
    const start = html.slice(0, newline + 1).split('\n').length;
    segments.push({ file, start, end: start + content.split('\n').length - 1 });
  }
  return segments.sort((a, b) => a.start - b.start);
}

/** Map a preview location like "about:srcdoc:96" back to project file + line. */
export function locateError(where: string | undefined, lineMap: LineSegment[]): ErrorTarget | null {
  if (!where) return null;
  const m = where.match(/:(\d+)\s*$/);
  if (!m) return null;
  const line = Number(m[1]);
  const seg = lineMap.find((s) => line >= s.start && line <= s.end);
  if (!seg) return null;
  return { file: seg.file, line: line - seg.start + 1 };
}

export function renderStandaloneHtml(project: Project): { entry: string | null; html: string; lineMap: LineSegment[] } {
  const entry = entryFor(project, project.activePath);
  if (!entry) return { entry: null, html: EMPTY_SHELL(project.name), lineMap: [] };
  const built = buildStandaloneHtml(project, entry);
  return { entry, html: built.html, lineMap: built.lineMap };
}

export function renderPreview(iframe: HTMLIFrameElement, html: string): void {
  iframe.srcdoc = html;
}

/** Open the current site in a new tab (blob URL, revoked after a minute). */
export function openInTab(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isPreviewMessage(e: MessageEvent, iframe: HTMLIFrameElement): boolean {
  return (
    !!e.data &&
    typeof e.data === 'object' &&
    (e.data as Record<string, unknown>)[PREVIEW_TAG] === 1 &&
    e.source === iframe.contentWindow
  );
}

export function entryFromMessage(e: MessageEvent): ConsoleEntry | null {
  const d = e.data as { kind?: unknown; text?: unknown; where?: unknown };
  if (d.kind !== 'log' && d.kind !== 'info' && d.kind !== 'warn' && d.kind !== 'error') return null;
  return {
    kind: d.kind,
    text: String(d.text ?? '').slice(0, 2000),
    where: typeof d.where === 'string' && d.where !== '' ? d.where : undefined,
    time: Date.now(),
  };
}
