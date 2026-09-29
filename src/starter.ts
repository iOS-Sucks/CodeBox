import { uid } from './store.ts';
import type { Project } from './types.ts';

// First-run demo project: shows how local css/js files are picked up
// by the preview, and how console.log lands in the Console panel.

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Welcome to CodeBox</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="card">
    <p class="kicker">■ CodeBox</p>
    <h1>Edit me, watch me update.</h1>
    <p>
      This file, <code>styles.css</code> and <code>app.js</code> live in your
      browser. Change anything and the preview rebuilds by itself.
    </p>
    <button id="btn" type="button">Clicked 0 times</button>
    <p class="hint">Open the Console panel below the preview, then click the button.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const STYLES_CSS = `* { box-sizing: border-box; border-radius: 0; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0a0a0a;
  color: #f4f4f4;
  font-family: system-ui, sans-serif;
}
.card {
  border: 1px solid #2a2a2a;
  padding: 32px;
  max-width: 460px;
  background: #101010;
}
.kicker { color: rgb(200, 255, 0); letter-spacing: 0.2em; margin: 0; }
h1 { margin: 8px 0 12px; }
code { font-family: ui-monospace, monospace; color: rgb(200, 255, 0); }
button {
  background: rgb(200, 255, 0);
  border: 1px solid rgb(200, 255, 0);
  color: #000;
  font-weight: 700;
  padding: 10px 18px;
  cursor: pointer;
}
button:hover { background: #fff; border-color: #fff; }
.hint { color: #9a9a9a; font-size: 13px; }
`;

const APP_JS = `let count = 0;
const btn = document.getElementById("btn");

btn.addEventListener("click", () => {
  count += 1;
  btn.textContent = "Clicked " + count + (count === 1 ? " time" : " times");
  console.log("button clicked", { count });
});
`;

export function starterProject(): Project {
  const now = Date.now();
  return {
    id: uid(),
    name: 'welcome',
    activePath: 'index.html',
    updatedAt: now,
    files: [
      { id: uid(), path: 'index.html', content: INDEX_HTML, updatedAt: now },
      { id: uid(), path: 'styles.css', content: STYLES_CSS, updatedAt: now },
      { id: uid(), path: 'app.js', content: APP_JS, updatedAt: now },
    ],
  };
}
