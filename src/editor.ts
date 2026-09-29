import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { parse } from 'acorn';

export interface EditorHandle {
  openFile(path: string, content: string): void;
  currentPath(): string | null;
  destroy(): void;
}

interface EditorOptions {
  onChange: (path: string, content: string) => void;
  /** Current JS syntax errors for the open file (empty when clean). */
  onDiagnostics: (path: string, diagnostics: Diagnostic[]) => void;
}

const MAX_LINT_BYTES = 120_000;

const voltTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#0d0d0d', color: '#f2f2f2' },
    '.cm-content': { caretColor: 'rgb(200,255,0)' },
    '.cm-cursor': { borderLeftColor: 'rgb(200,255,0)' },
    '.cm-gutters': { backgroundColor: '#0d0d0d', color: '#6b6b6b', borderRight: '1px solid #1b1b1b' },
    '.cm-activeLine': { backgroundColor: 'rgba(200,255,0,0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(200,255,0,0.08)', color: 'rgb(200,255,0)' },
    '&.cm-focused': { outline: '1px solid rgba(200,255,0,0.55)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(200,255,0,0.25)' },
    '.cm-tooltip': { backgroundColor: '#111', border: '1px solid #333', color: '#f2f2f2' },
    '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px solid #ff5d5d' },
    '.cm-searchMatch': { backgroundColor: 'rgba(200,255,0,0.3)' },
  },
  { dark: true },
);

const voltHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6f6f6f', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'rgb(200,255,0)', fontWeight: 'bold' },
  { tag: [tags.string, tags.regexp], color: '#e8e8e8' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'rgb(200,255,0)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#ffffff' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: '#d7d7d7' },
  { tag: [tags.tagName, tags.typeName, tags.className], color: '#ffffff', fontWeight: 'bold' },
  { tag: tags.operator, color: 'rgb(200,255,0)' },
  { tag: tags.meta, color: '#9a9a9a' },
]);

function isJsPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'js' || ext === 'mjs' || ext === 'cjs';
}

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return html();
  if (ext === 'css') return css();
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return javascript();
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
  let path: string | null = null;
  let lastDiagKey = '';

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
        lineNumbers(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightSelectionMatches(),
        syntaxHighlighting(voltHighlight),
        voltTheme,
        lintGutter(),
        language.of([]),
        lint.of([]),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && path) {
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
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: [
          language.reconfigure(languageFor(nextPath)),
          // Only plain .js files get the syntax linter: inside .html the
          // same check would flag markup as broken JavaScript.
          lint.reconfigure(isJsPath(nextPath) ? linter(jsLinter, { delay: 400 }) : []),
        ],
      });
      if (isJsPath(nextPath)) checkDiagnostics(view);
      else opts.onDiagnostics(nextPath, []);
    },
    destroy() {
      path = null;
      view.destroy();
    },
  };
}
