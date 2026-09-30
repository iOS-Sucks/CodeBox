import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript, javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, Decoration, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { parse } from 'acorn';
import { ACCENT_DEFAULT, parseAccent, type AppSettings, type Rgb } from './settings.ts';

export interface EditorHandle {
  openFile(path: string, content: string): void;
  currentPath(): string | null;
  /** Box + scroll to a 1-based line (used when jumping from a console error). */
  highlightLine(line: number): void;
  /** Re-apply accent, font size, tabs, wrap and gutters without losing content. */
  updateSettings(s: AppSettings): void;
  destroy(): void;
}

interface EditorOptions {
  settings: AppSettings;
  onChange: (path: string, content: string) => void;
  /** Current JS syntax errors for the open file (empty when clean). */
  onDiagnostics: (path: string, diagnostics: Diagnostic[]) => void;
  /** Cursor line (1-based), column (1-based) and selected character count. */
  onCursor: (line: number, col: number, selected: number) => void;
}

const MAX_LINT_BYTES = 120_000;

function accentOf(s: AppSettings): Rgb {
  return parseAccent(s.accent) ?? parseAccent(ACCENT_DEFAULT) ?? [200, 255, 0];
}

/** Editor chrome rebuilt from the accent + font size (single source of truth). */
function themeFor(accent: Rgb, fontSize: number) {
  const [r, g, b] = accent;
  const rgb = `rgb(${r},${g},${b})`;
  const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;
  return [
    EditorView.theme(
      {
        '&': { backgroundColor: '#0d0d0d', color: '#f2f2f2', fontSize: `${fontSize}px` },
        '.cm-content': { caretColor: rgb },
        '.cm-cursor': { borderLeftColor: rgb },
        '.cm-gutters': { backgroundColor: '#0d0d0d', color: '#6b6b6b', borderRight: '1px solid #1b1b1b' },
        '.cm-activeLine': { backgroundColor: rgba(0.06) },
        '.cm-activeLineGutter': { backgroundColor: rgba(0.08), color: rgb },
        '&.cm-focused': { outline: `1px solid ${rgba(0.55)}` },
        '.cm-selectionBackground': { backgroundColor: rgba(0.25) },
        '.cm-tooltip': { backgroundColor: '#111', border: '1px solid #333', color: '#f2f2f2' },
        '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px solid #ff5d5d' },
        '.cm-searchMatch': { backgroundColor: rgba(0.3) },
      },
      { dark: true },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.comment, color: '#6f6f6f', fontStyle: 'italic' },
        { tag: tags.keyword, color: rgb, fontWeight: 'bold' },
        { tag: [tags.string, tags.regexp], color: '#e8e8e8' },
        { tag: [tags.number, tags.bool, tags.atom], color: rgb },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#ffffff' },
        { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: '#d7d7d7' },
        { tag: [tags.tagName, tags.typeName, tags.className], color: '#ffffff', fontWeight: 'bold' },
        { tag: tags.operator, color: rgb },
        { tag: tags.meta, color: '#9a9a9a' },
      ]),
    ),
  ];
}

/** Gutters, wrap, indent width and theme — everything the settings own. */
function settingsExtensions(s: AppSettings) {
  return [
    ...themeFor(accentOf(s), s.fontSize),
    s.lineNumbers ? lineNumbers() : [],
    s.wrap ? EditorView.lineWrapping : [],
    indentUnit.of(' '.repeat(s.tabSize)),
  ];
}

function isJsPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'js' || ext === 'mjs' || ext === 'cjs';
}

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return html({ autoCloseTags: true });
  if (ext === 'css') return css();
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return [
      javascript(),
      // Browser + JS globals (document, console, Math, fetch, …) with real
      // member completion reflected from the runtime (document. → getElementById…).
      javascriptLanguage.data.of({ autocomplete: scopeCompletionSource(globalThis) }),
    ];
  }
  if (ext === 'json') return json();
  return [];
}

interface JsSyntaxError {
  message: string;
  line: number;
  column: number;
}

/** First syntax error in the code, or null when it parses cleanly. */
function parseJs(code: string): JsSyntaxError | null {
  const attempts: Array<'module' | 'script'> = ['module', 'script'];
  let first: unknown = null;
  for (const sourceType of attempts) {
    try {
      parse(code, { ecmaVersion: 'latest', sourceType });
      return null;
    } catch (err) {
      first ??= err;
    }
  }
  if (typeof first !== 'object' || first === null || !('message' in first)) return null;
  const loc = (first as { loc?: { line: number; column: number } }).loc;
  return {
    message: String((first as { message: unknown }).message),
    line: typeof loc?.line === 'number' ? loc.line : 1,
    column: typeof loc?.column === 'number' ? loc.column : 0,
  };
}

function jsLinter(view: EditorView): Diagnostic[] {
  const code = view.state.doc.toString();
  if (!code.trim() || code.length > MAX_LINT_BYTES) return [];
  const err = parseJs(code);
  if (!err) return [];
  try {
    const line = view.state.doc.line(Math.min(Math.max(err.line, 1), view.state.doc.lines));
    const from = Math.min(line.from + err.column, line.to);
    return [{ from, to: Math.min(from + 1, line.to === from ? from + 1 : line.to), severity: 'error', message: err.message }];
  } catch {
    return [{ from: 0, to: 0, severity: 'error', message: err.message }];
  }
}

export function createEditor(el: HTMLElement, opts: EditorOptions): EditorHandle {
  const language = new Compartment();
  const lint = new Compartment();
  const mark = new Compartment();
  const conf = new Compartment();
  let path: string | null = null;
  let lastDiagKey = '';
  let marked = false;

  const clearMark = () => {
    if (!marked) return;
    marked = false;
    // Deferred: never dispatch from inside an update listener.
    queueMicrotask(() => {
      try {
        view.dispatch({ effects: mark.reconfigure(EditorView.decorations.of(Decoration.none)) });
      } catch {
        // View already destroyed.
      }
    });
  };

  const checkDiagnostics = (view: EditorView) => {
    if (!path || !isJsPath(path)) return;
    const list = jsLinter(view);
    const key = list.map((d) => `${d.from}:${d.to}:${d.message}`).join('|');
    if (key !== lastDiagKey) {
      lastDiagKey = key;
      opts.onDiagnostics(path, list);
    }
  };

  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: '',
      extensions: [
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true }),
        highlightSelectionMatches(),
        conf.of(settingsExtensions(opts.settings)),
        lintGutter(),
        search({ top: true }),
        language.of([]),
        lint.of([]),
        mark.of(EditorView.decorations.of(Decoration.none)),
        keymap.of([
          // Tab accepts the selected completion, otherwise indents — like VS Code.
          { key: 'Tab', run: (v) => acceptCompletion(v) || indentMore(v) },
          { key: 'Shift-Tab', run: indentLess },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          const head = update.state.selection.main.head;
          const anchor = update.state.selection.main.anchor;
          const line = update.state.doc.lineAt(head);
          opts.onCursor(line.number, head - line.from + 1, Math.abs(head - anchor));
          if (update.docChanged && path) {
            clearMark();
            opts.onChange(path, update.state.doc.toString());
            checkDiagnostics(update.view);
          }
        }),
      ],
    }),
  });

  return {
    currentPath: () => path,
    openFile(nextPath: string, content: string) {
      path = nextPath;
      lastDiagKey = '';
      marked = false;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: [
          language.reconfigure(languageFor(nextPath)),
          // Only plain .js files get the syntax linter: inside .html the
          // same check would flag markup as broken JavaScript.
          lint.reconfigure(isJsPath(nextPath) ? linter(jsLinter, { delay: 400 }) : []),
          mark.reconfigure(EditorView.decorations.of(Decoration.none)),
        ],
      });
      if (isJsPath(nextPath)) checkDiagnostics(view);
      else opts.onDiagnostics(nextPath, []);
    },
    highlightLine(lineNum: number) {
      try {
        const line = view.state.doc.line(Math.min(Math.max(lineNum, 1), view.state.doc.lines));
        marked = true;
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
          effects: mark.reconfigure(
            EditorView.decorations.of(Decoration.set([Decoration.line({ class: 'cm-jump-line' }).range(line.from)])),
          ),
        });
      } catch {
        // Line vanished under edits — nothing to box.
      }
    },
    updateSettings(s: AppSettings) {
      view.dispatch({ effects: conf.reconfigure(settingsExtensions(s)) });
    },
    destroy() {
      path = null;
      view.destroy();
    },
  };
}
