import './style.css';
import { createEditor, type EditorHandle } from './editor.ts';
import {
  entryFromMessage,
  isPreviewMessage,
  locateError,
  openInTab,
  renderPreview,
  renderStandaloneHtml,
  type ConsoleEntry,
  type ErrorTarget,
  type LineSegment,
} from './preview.ts';
import {
  createProject,
  getFile,
  getProject,
  loadState,
  persist,
  realFiles,
  sanitizePath,
  storageBytes,
  upsertFile,
  KEEP_NAME,
  STORAGE_KEY,
} from './store.ts';
import { starterProject } from './starter.ts';
import { renderTree, showCreateRow } from './tree.ts';
import { classifyName, downloadBlob, exportZip, importZip, MAX_FILE_BYTES } from './zip.ts';
import {
  ACCENT_PRESETS,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  applySettingsToDom,
  hexToAccent,
  loadSettings,
  saveSettings,
} from './settings.ts';
import type { CodeFile, Project } from './types.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const SAVE_DEBOUNCE_MS = 500;
const PREVIEW_DEBOUNCE_MS = 400;
const MAX_CONSOLE_ENTRIES = 200;

const BOOT_HTML_STARTER = (name: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${name}</title>\n</head>\n<body>\n  <h1>${name}</h1>\n</body>\n</html>\n`;

function starterContent(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return BOOT_HTML_STARTER(path.split('/').pop() ?? 'page');
  if (ext === 'css') return `/* ${path} */\n`;
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return `// ${path}\n`;
  return '';
}

function main(): void {
  let state = loadState();
  if (state.projects.length === 0) {
    const welcome = starterProject();
    state = { version: 1, projects: [welcome], activeProjectId: welcome.id };
    persist(state);
  }

  let settings = loadSettings();
  applySettingsToDom(settings);

  const projectSelect = el<HTMLSelectElement>('project-select');
  const treeEl = el('tree');
  const editorHost = el('editor');
  const activePathEl = el('active-path');
  const docErrors = el('doc-errors');
  const saveDot = el('save-dot');
  const saveState = el('save-state');
  const storageNote = el('storage-note');
  const entryLabel = el('entry-label');
  const stageWrap = el('stage-wrap');
  const iframe = el<HTMLIFrameElement>('preview');
  const consoleBox = el<HTMLDetailsElement>('console-box');
  const consoleList = el<HTMLOListElement>('console-list');
  const consoleCount = el('console-count');
  const fileInput = el<HTMLInputElement>('file-input');
  const zipInput = el<HTMLInputElement>('zip-input');

  let saveTimer = 0;
  let previewTimer = 0;
  let lastHtml = '';
  let lastLineMap: LineSegment[] = [];
  let entries: ConsoleEntry[] = [];

  const project = (): Project | null => getProject(state, state.activeProjectId);

  const editor: EditorHandle = createEditor(editorHost, {
    settings,    onChange: (path, content) => {
      const p = project();
      const file = p ? getFile(p, path) : null;
      if (!p || !file || file.content === content) return;
      file.content = content;
      file.updatedAt = Date.now();
      p.updatedAt = file.updatedAt;
      scheduleSave();
      schedulePreview();
    },
    onDiagnostics: (path, diagnostics) => {
      if (path !== editor.currentPath()) return;
      if (diagnostics.length === 0) {
        docErrors.hidden = true;
        docErrors.textContent = '';
        return;
      }
      const first = diagnostics[0];
      docErrors.hidden = false;
      docErrors.textContent =
        diagnostics.length === 1 ? `JS error: ${first.message}` : `JS error: ${first.message} (+${diagnostics.length - 1} more)`;
    },
  });

  /* ---------- persistence + status ---------- */

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function saveNow(): void {
    const result = persist(state);
    const now = new Date();
    if (result.ok) {
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      saveState.textContent = `Saved ${time}`;
      saveDot.textContent = 'saved';
      renderStorageNote(result.bytes, null);
    } else {
      renderStorageNote(result.bytes, 'Local storage is full — export a .zip backup, then delete unused projects.');
    }
  }

  function renderStorageNote(bytes: number, error: string | null): void {
    const p = project();
    const count = p ? realFiles(p).length : 0;
    const kb = (bytes / 1024).toFixed(1);
    if (error) {
      storageNote.textContent = error;
      storageNote.classList.add('over');
    } else {
      storageNote.textContent = `${count} file${count === 1 ? '' : 's'} · ${kb} KB saved in this browser`;
      storageNote.classList.remove('over');
    }
  }

  /* ---------- console panel ---------- */

  function pushConsole(entry: ConsoleEntry): void {
    entries.push(entry);
    if (entries.length > MAX_CONSOLE_ENTRIES) entries = entries.slice(-MAX_CONSOLE_ENTRIES);
    renderConsole();
    if (entry.kind === 'error' && settings.consoleAutoOpen) consoleBox.open = true;
  }

  function renderConsole(): void {
    const stick = consoleList.scrollHeight - consoleList.scrollTop - consoleList.clientHeight < 40;
    consoleList.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = entry.kind;
      li.textContent = entry.text;
      if (entry.target) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'where-btn';
        jump.textContent = `${entry.target.file}:${entry.target.line}`;
        jump.title = `Open ${entry.target.file} at line ${entry.target.line}`;
        jump.addEventListener('click', () => jumpToError(entry.target as ErrorTarget));
        li.appendChild(jump);
      } else if (entry.where) {
        const where = document.createElement('span');
        where.className = 'where';
        where.textContent = ` ${entry.where}`;
        li.appendChild(where);
      }
      consoleList.appendChild(li);
    }
    if (stick) consoleList.scrollTop = consoleList.scrollHeight;
    const errors = entries.filter((e) => e.kind === 'error').length;
    consoleCount.textContent = entries.length === 0 ? '' : `(${entries.length}${errors > 0 ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''})`;
  }

  /** Open the file an error came from and box the offending line. */
  function jumpToError(target: ErrorTarget): void {
    const p = project();
    const file = p ? getFile(p, target.file) : null;
    if (!p || !file || file.content.startsWith('data:')) return;
    p.activePath = file.path;
    p.updatedAt = Date.now();
    scheduleSave();
    openActiveFile();
    rebuildPreview();
    renderTreeEl();
    if (editor.currentPath() === file.path) editor.highlightLine(target.line);
  }

  /* ---------- rendering ---------- */

  function renderProjects(): void {
    projectSelect.replaceChildren();
    for (const p of state.projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      projectSelect.appendChild(opt);
    }
    projectSelect.value = state.activeProjectId ?? '';
  }

  function renderTreeEl(): void {
    const p = project();
    if (!p) {
      treeEl.replaceChildren();
      return;
    }
    renderTree(treeEl, p, p.activePath, {
      onSelect: (path) => {
        p.activePath = path;
        p.updatedAt = Date.now();
        saveNow();
        openActiveFile();
        rebuildPreview();
        renderTreeEl();
      },
      onDelete: (path) => {
        p.files = p.files.filter((f) => f.path !== path);
        pruneKeepFiles(p, path);
        if (p.activePath === path) {
          p.activePath = realFiles(p).find((f) => f.path.toLowerCase().endsWith('.html'))?.path ?? realFiles(p)[0]?.path ?? null;
        }
        p.updatedAt = Date.now();
        saveNow();
        openActiveFile();
        rebuildPreview();
        renderTreeEl();
      },
      onRename: (oldPath, raw) => {
        const next = sanitizePath(raw);
        if (!next || next === oldPath || getFile(p, next)) {
          renderTreeEl();
          return;
        }
        const file = getFile(p, oldPath);
        if (file) {
          file.path = next;
          file.updatedAt = Date.now();
          if (p.activePath === oldPath) p.activePath = next;
          p.updatedAt = file.updatedAt;
          saveNow();
          openActiveFile();
          rebuildPreview();
        }
        renderTreeEl();
      },
      onCreate: (raw) => createPath(p, raw, false),
    });
  }

  function isBinary(file: CodeFile): boolean {
    return file.content.startsWith('data:');
  }

  function openActiveFile(): void {
    const p = project();
    const file = p ? getFile(p, p.activePath) : null;
    activePathEl.classList.toggle('chip', file !== null);
    if (!p || !file) {
      activePathEl.textContent = '—';
      showEditorEmpty('No file selected.');
      docErrors.hidden = true;
      return;
    }
    activePathEl.textContent = file.path;
    if (isBinary(file)) {
      showEditorEmpty('This is an image file — it renders in the preview below.');
      docErrors.hidden = true;
      return;
    }
    hideEditorEmpty();
    if (editor.currentPath() !== file.path) editor.openFile(file.path, file.content);
  }

  function showEditorEmpty(text: string): void {
    hideEditorEmpty();
    const cm = editorHost.querySelector('.cm-editor');
    if (cm instanceof HTMLElement) cm.style.display = 'none';
    const note = document.createElement('p');
    note.id = 'editor-empty';
    note.textContent = text;
    editorHost.appendChild(note);
  }

  function hideEditorEmpty(): void {
    editorHost.querySelector('#editor-empty')?.remove();
    const cm = editorHost.querySelector('.cm-editor');
    if (cm instanceof HTMLElement) cm.style.display = '';
  }

  function rebuildPreview(): void {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    const p = project();
    if (!p) return;
    const { entry, html, lineMap } = renderStandaloneHtml(p);
    lastHtml = html;
    lastLineMap = lineMap;
    entryLabel.textContent = entry ? `entry: ${entry}` : 'no HTML file';
    renderPreview(iframe, html);
  }

  function schedulePreview(): void {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    if (!settings.autoPreview) return;
    previewTimer = window.setTimeout(rebuildPreview, PREVIEW_DEBOUNCE_MS);
  }

  function renderAll(): void {
    renderProjects();
    renderTreeEl();
    openActiveFile();
    rebuildPreview();
    renderStorageNote(storageBytes(state), null);
    renderConsole();
  }

  /* ---------- mutations ---------- */

  function createPath(p: Project, raw: string, folderMode: boolean): void {
    const clean = folderMode ? sanitizePath(`${raw}/${KEEP_NAME}`) : sanitizePath(raw);
    if (!clean) {
      renderTreeEl();
      return;
    }
    const existing = getFile(p, clean);
    if (existing) {
      p.activePath = clean;
    } else if (folderMode) {
      upsertFile(p, clean, '');
    } else {
      upsertFile(p, clean, starterContent(clean));
      p.activePath = clean;
    }
    p.updatedAt = Date.now();
    saveNow();
    openActiveFile();
    rebuildPreview();
    renderTreeEl();
  }

  /** Drop folder markers left behind when a folder loses its last file. */
  function pruneKeepFiles(p: Project, deletedPath: string): void {
    const dir = deletedPath.includes('/') ? deletedPath.slice(0, deletedPath.lastIndexOf('/')) : '';
    let prefix = dir;
    while (prefix !== '') {
      const stillUsed = p.files.some((f) => f.path !== `${prefix}/${KEEP_NAME}` && f.path.startsWith(`${prefix}/`));
      if (stillUsed) break;
      p.files = p.files.filter((f) => f.path !== `${prefix}/${KEEP_NAME}`);
      prefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    }
  }

  async function addImported(files: Array<{ path: string; content: string }>): Promise<void> {
    const p = project();
    if (!p) return;
    for (const f of files) upsertFile(p, f.path, f.content);
    const index = files.find((f) => f.path.toLowerCase() === 'index.html');
    if (index) p.activePath = index.path;
    else if (!getFile(p, p.activePath)) p.activePath = files[0]?.path ?? p.activePath;
    p.updatedAt = Date.now();
    saveNow();
    openActiveFile();
    rebuildPreview();
    renderTreeEl();
  }

  function readUploadedFile(file: File, path: string): Promise<{ path: string; content: string } | null> {
    const kind = classifyName(path);
    if (kind === 'unsupported' || file.size > MAX_FILE_BYTES) return Promise.resolve(null);
    if (kind === 'image') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? { path, content: reader.result } : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }
    return file.text().then((content) => ({ path, content }));
  }

  interface EntryLike {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    file: (ok: (f: File) => void, bad: () => void) => void;
    createReader: () => { readEntries: (ok: (es: EntryLike[]) => void, bad: () => void) => void };
  }

  async function collectDropped(dt: DataTransfer): Promise<Array<{ path: string; file: File }>> {
    const items = [...dt.items].filter((i) => i.kind === 'file');
    const getEntry = (item: DataTransferItem): EntryLike | null => {
      const withFs = item as unknown as { webkitGetAsEntry?: () => EntryLike | null };
      try {
        return withFs.webkitGetAsEntry?.() ?? null;
      } catch {
        return null;
      }
    };
    const roots = items.map(getEntry).filter((e): e is EntryLike => e !== null);
    if (roots.length > 0) {
      const out: Array<{ path: string; file: File }> = [];
      const walk = async (entry: EntryLike, base: string): Promise<void> => {
        if (entry.isFile) {
          const file = await new Promise<File | null>((resolve) => {
            entry.file(
              (f) => resolve(f),
              () => resolve(null),
            );
          });
          if (file) out.push({ path: base + entry.name, file });
        } else if (entry.isDirectory) {
          const children = await new Promise<EntryLike[]>((resolve) => {
            entry.createReader().readEntries(
              (es) => resolve(es),
              () => resolve([]),
            );
          });
          for (const child of children) await walk(child, `${base}${entry.name}/`);
        }
      };
      for (const root of roots) await walk(root, '');
      return out;
    }
    return [...dt.files].map((f) => ({ path: f.name, file: f }));
  }

  async function handleDroppedFiles(list: Array<{ path: string; file: File }>): Promise<void> {
    if (list.length === 1 && list[0].path.toLowerCase().endsWith('.zip')) {
      await handleZipBlob(list[0].file);
      return;
    }
    const imported: Array<{ path: string; content: string }> = [];
    let skipped = 0;
    for (const { path, file } of list) {
      const clean = sanitizePath(path);
      if (!clean) {
        skipped += 1;
        continue;
      }
      const read = await readUploadedFile(file, clean);
      if (!read) skipped += 1;
      else imported.push(read);
    }
    if (imported.length === 0) {
      pushConsole({ kind: 'warn', text: 'Nothing importable — drop HTML, CSS, JS, images or a .zip.', time: Date.now() });
      return;
    }
    await addImported(imported);
    pushConsole({
      kind: 'info',
      text: `Imported ${imported.length} file${imported.length === 1 ? '' : 's'}${skipped > 0 ? `, skipped ${skipped}` : ''}.`,
      time: Date.now(),
    });
  }

  async function handleZipBlob(blob: Blob): Promise<void> {
    try {
      const { files, skipped } = await importZip(blob);
      await addImported(files);
      pushConsole({
        kind: 'info',
        text: `Imported ${files.length} files from zip${skipped.length > 0 ? `, skipped ${skipped.length}` : ''}.`,
        time: Date.now(),
      });
    } catch (err) {
      pushConsole({ kind: 'error', text: err instanceof Error ? err.message : 'Could not read that zip.', time: Date.now() });
    }
  }

  /* ---------- events ---------- */

  projectSelect.addEventListener('change', () => {
    state.activeProjectId = projectSelect.value;
    entries = [];
    saveNow();
    renderTreeEl();
    openActiveFile();
    rebuildPreview();
    renderConsole();
  });

  el('btn-project-add').addEventListener('click', () => {
    const p = createProject(`project-${state.projects.length + 1}`);
    state.projects.push(p);
    state.activeProjectId = p.id;
    saveNow();
    renderProjects();
    renderTreeEl();
    openActiveFile();
    rebuildPreview();
  });

  el('btn-project-rename').addEventListener('click', () => {
    const p = project();
    if (!p) return;
    const input = document.createElement('input');
    input.value = p.name;
    input.setAttribute('aria-label', 'Project name');
    input.style.cssText = 'max-width:240px;background:#000;border:1px solid rgb(200,255,0);color:#f4f4f4;padding:6px 12px;font:inherit;';
    projectSelect.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok && input.value.trim()) {
        p.name = input.value.trim();
        p.updatedAt = Date.now();
        saveNow();
      }
      input.replaceWith(projectSelect);
      renderProjects();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });

  el('btn-project-delete').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const p = project();
    if (!p) return;
    if (!btn.classList.contains('danger-armed')) {
      btn.classList.add('danger-armed');
      btn.textContent = 'Sure?';
      window.setTimeout(() => {
        btn.classList.remove('danger-armed');
        btn.textContent = 'Delete';
      }, 2500);
      return;
    }
    btn.classList.remove('danger-armed');
    btn.textContent = 'Delete';
    state.projects = state.projects.filter((x) => x.id !== p.id);
    if (state.projects.length === 0) {
      const fresh = starterProject();
      state.projects.push(fresh);
    }
    if (state.activeProjectId === p.id) state.activeProjectId = state.projects[0].id;
    entries = [];
    saveNow();
    renderAll();
  });

  el('btn-new-file').addEventListener('click', () => {
    const p = project();
    if (p) showCreateRow(treeEl, '', { onSelect: () => {}, onDelete: () => {}, onRename: () => {}, onCreate: (v) => createPath(p, v, false) });
  });

  el('btn-new-folder').addEventListener('click', () => {
    const p = project();
    if (p) showCreateRow(treeEl, 'folder/', { onSelect: () => {}, onDelete: () => {}, onRename: () => {}, onCreate: (v) => createPath(p, v, true) });
  });

  /* ---------- dropdown menus ---------- */

  const menuRoots = [...document.querySelectorAll<HTMLElement>('[data-menu]')];
  function closeMenus(): void {
    for (const root of menuRoots) {
      root.querySelector('.menu-panel')?.setAttribute('hidden', '');
      root.querySelector('[aria-haspopup="menu"]')?.setAttribute('aria-expanded', 'false');
    }
  }
  for (const root of menuRoots) {
    const btn = root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    const panel = root.querySelector<HTMLElement>('.menu-panel');
    if (!btn || !panel) continue;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !panel.hasAttribute('hidden');
      closeMenus();
      if (!open) {
        panel.removeAttribute('hidden');
        btn.setAttribute('aria-expanded', 'true');
        panel.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      }
    });
    panel.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[role="menuitem"]')) closeMenus();
    });
  }
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-menu]')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  el('btn-import-files').addEventListener('click', () => fileInput.click());
  el('btn-import-zip').addEventListener('click', () => zipInput.click());

  fileInput.addEventListener('change', () => {
    const list = [...(fileInput.files ?? [])].map((f) => ({ path: f.name, file: f }));
    fileInput.value = '';
    void handleDroppedFiles(list);
  });

  zipInput.addEventListener('change', () => {
    const file = zipInput.files?.[0];
    zipInput.value = '';
    if (file) void handleZipBlob(file);
  });

  el('btn-export-zip').addEventListener('click', () => {
    const p = project();
    if (!p) return;
    void exportZip(p).then((blob) => downloadBlob(blob, `${p.name}.zip`));
  });

  el('btn-export-html').addEventListener('click', () => {
    const p = project();
    if (!p || !lastHtml) return;
    downloadBlob(new Blob([lastHtml], { type: 'text/html' }), `${p.name}.html`);
  });

  el('btn-open-tab').addEventListener('click', () => {
    if (lastHtml) openInTab(lastHtml);
  });

  const fullscreenBtn = el('btn-fullscreen');
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void stageWrap.requestFullscreen().catch(() => {
        pushConsole({ kind: 'warn', text: 'Fullscreen was blocked — use “Open in tab” instead.', time: Date.now() });
      });
    }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  el('btn-console-clear').addEventListener('click', () => {
    entries = [];
    renderConsole();
  });

  window.addEventListener('message', (e) => {
    if (!isPreviewMessage(e, iframe)) return;
    const entry = entryFromMessage(e);
    if (!entry) return;
    entry.target = locateError(entry.where, lastLineMap) ?? undefined;
    pushConsole(entry);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      rebuildPreview();
      saveDot.textContent = 'saved ✓';
    }
  });

  /* ---------- settings ---------- */

  const dialog = el<HTMLDialogElement>('settings-dialog');
  const accentGrid = el('accent-grid');
  const customColor = el<HTMLInputElement>('accent-custom');
  const accentHex = el('accent-hex');
  const gradientsBox = el<HTMLInputElement>('set-gradients');
  const gradientToPicker = el<HTMLInputElement>('gradient-to');
  const gradientHex = el('gradient-hex');
  const gradientAngle = el<HTMLInputElement>('gradient-angle');
  const gradientAngleVal = el('gradient-angle-val');
  const fontSizeRange = el<HTMLInputElement>('set-fontsize');
  const fontSizeVal = el('fontsize-val');
  const tabSizeSelect = el<HTMLSelectElement>('set-tabsize');
  const wrapBox = el<HTMLInputElement>('set-wrap');
  const lineNumbersBox = el<HTMLInputElement>('set-linenumbers');
  const autoPreviewBox = el<HTMLInputElement>('set-autopreview');
  const consoleOpenBox = el<HTMLInputElement>('set-consoleopen');

  for (const preset of ACCENT_PRESETS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.dataset.rgb = preset.rgb;
    swatch.style.background = `rgb(${preset.rgb})`;
    swatch.setAttribute('role', 'radio');
    swatch.title = preset.name;
    swatch.setAttribute('aria-label', `${preset.name} accent`);
    swatch.addEventListener('click', () => {
      settings.accent = preset.rgb;
      commitSettings();
    });
    accentGrid.appendChild(swatch);
  }

  function commitSettings(): void {
    saveSettings(settings);
    applySettingsToDom(settings);
    editor.updateSettings(settings);
    syncSettingsUI();
  }

  function syncSettingsUI(): void {
    for (const sw of accentGrid.querySelectorAll('.swatch')) {
      const node = sw as HTMLElement;
      node.setAttribute('aria-checked', node.dataset.rgb === settings.accent ? 'true' : 'false');
    }
    accentHex.textContent = `rgb(${settings.accent})`;
    gradientsBox.checked = settings.gradients;
    gradientHex.textContent = `rgb(${settings.gradientTo})`;
    gradientAngle.value = String(settings.gradientAngle);
    gradientAngleVal.textContent = `${settings.gradientAngle}°`;
    fontSizeRange.value = String(settings.fontSize);
    fontSizeVal.textContent = String(settings.fontSize);
    tabSizeSelect.value = String(settings.tabSize);
    wrapBox.checked = settings.wrap;
    lineNumbersBox.checked = settings.lineNumbers;
    autoPreviewBox.checked = settings.autoPreview;
    consoleOpenBox.checked = settings.consoleAutoOpen;
    el('settings-usage').textContent =
      `${(storageBytes(state) / 1024).toFixed(1)} KB stored in this browser · settings save automatically`;
  }

  customColor.addEventListener('input', () => {
    const rgb = hexToAccent(customColor.value);
    if (rgb) {
      settings.accent = rgb;
      commitSettings();
    }
  });
  gradientsBox.addEventListener('change', () => {
    settings.gradients = gradientsBox.checked;
    commitSettings();
  });
  gradientToPicker.addEventListener('input', () => {
    const rgb = hexToAccent(gradientToPicker.value);
    if (rgb) {
      settings.gradientTo = rgb;
      commitSettings();
    }
  });
  gradientAngle.addEventListener('input', () => {
    settings.gradientAngle = Number(gradientAngle.value);
    commitSettings();
  });
  fontSizeRange.addEventListener('input', () => {
    settings.fontSize = Number(fontSizeRange.value);
    commitSettings();
  });
  tabSizeSelect.addEventListener('change', () => {
    settings.tabSize = tabSizeSelect.value === '4' ? 4 : 2;
    commitSettings();
  });
  wrapBox.addEventListener('change', () => {
    settings.wrap = wrapBox.checked;
    commitSettings();
  });
  lineNumbersBox.addEventListener('change', () => {
    settings.lineNumbers = lineNumbersBox.checked;
    commitSettings();
  });
  autoPreviewBox.addEventListener('change', () => {
    settings.autoPreview = autoPreviewBox.checked;
    commitSettings();
    rebuildPreview();
  });
  consoleOpenBox.addEventListener('change', () => {
    settings.consoleAutoOpen = consoleOpenBox.checked;
    commitSettings();
  });

  el('btn-settings-reset').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    commitSettings();
  });

  const eraseBtn = el<HTMLButtonElement>('btn-data-erase');
  eraseBtn.addEventListener('click', () => {
    if (!eraseBtn.classList.contains('danger-armed')) {
      eraseBtn.classList.add('danger-armed');
      eraseBtn.textContent = 'Click again to erase';
      window.setTimeout(() => {
        eraseBtn.classList.remove('danger-armed');
        eraseBtn.textContent = 'Erase all local data';
      }, 2500);
      return;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SETTINGS_KEY);
    } finally {
      location.reload();
    }
  });

  el('btn-settings').addEventListener('click', () => {
    syncSettingsUI();
    dialog.showModal();
  });
  el('btn-settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  /* ---------- drag & drop ---------- */

  const veil = el('drop-veil');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    veil.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) veil.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    veil.hidden = true;
    const dt = e.dataTransfer;
    if (dt) void collectDropped(dt).then(handleDroppedFiles);
  });

  /* ---------- boot ---------- */

  renderAll();
  const boot = el('boot');
  const hideBoot = () => {
    boot.classList.add('done');
    window.setTimeout(() => boot.remove(), 400);
  };
  boot.addEventListener('click', hideBoot, { once: true });
  window.setTimeout(hideBoot, 1100);
}

main();
