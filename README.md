# CodeBox

Edit HTML, CSS and JS in your browser with a live preview. No account, no cookies,
no backend — projects stay in your browser's `localStorage`.

**[Try CodeBox live](https://ios-sucks.github.io/CodeBox/)** — deployed from `main`
via GitHub Pages.

## Features

- **File system per project** — create/rename/delete files and folders, or drag &
  drop files and whole folders from your OS straight into the app.
- **Import / export menus** — import files or a site `.zip`; export the project as
  `.zip` or the preview as a single standalone `.html` file.
- **Highlighted editor** — CodeMirror 6 with HTML/CSS/JS/JSON grammars, volt-on-black
  theme, auto-closing tags and brackets, and scope-aware completions for tags,
  CSS properties, JS globals and your own variables. `Tab` accepts a suggestion,
  `Shift-Tab` unindents.
- **Error highlighting** — JS syntax errors get gutter markers plus a message bar;
  runtime errors and `console.*` output from the preview land in the Console panel,
  mapped back to the real file and line — click one to jump straight to it.
- **Live preview** — local `<link>`/`<script>`/`<img>` references are inlined into
  one sandboxed document (`sandbox="allow-scripts"`), rebuilt ~400ms after you type.
- **Fullscreen + new tab** — present a site fullscreen or pop it out into its own tab.
- **Squary B/W design** — sharp corners, black & white, `rgb(200, 255, 0)` accent,
  subtle motion (disabled under `prefers-reduced-motion`).
- **Settings window** — restyle the accent with 9 presets or a custom color
  picker, design the beta gradient in a mini gradient editor (end color, angle,
  live preview), tune the editor (font size, tab width,
  wrap, line numbers), control live preview and console behavior, and manage
  local data. Everything saves to `localStorage` automatically.

## Privacy

CodeBox sets no cookies and makes no network requests of its own. Everything you
type is stored only in `localStorage` under `codebox.projects.v1` (~4.5MB cap;
you'll get a warning instead of silent data loss when it's full).

## Develop

Requires Node 20+.

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
```

Pushing to `main` builds and deploys to GitHub Pages automatically
(`.github/workflows/deploy.yml`).

## How the preview works

There is no server, so the preview bundles the project client-side: the entry
file (open `.html` file, else `index.html`, else the first `.html`) is copied and
its **relative** `href`/`src` references to project files are inlined
(`<link>` → `<style>`, `<script src>` → `<script>`, local `<img>` → data URL).
Absolute URLs, `data:`/`blob:` URLs and anchors are left untouched. A tiny hook
script forwards errors and console output to the app via `postMessage`.

## Limits (v1, honest)

- One file open in the editor at a time (no multi-tab); switching files keeps content, not undo history.
- Syntax underlining covers plain `.js` files; markup/style issues surface as preview runtime errors.
- `localStorage` caps total size — large image-heavy projects should stay small or be exported to `.zip` regularly.
