import { isKeepFile, sortedFiles } from './store.ts';
import type { Project } from './types.ts';

export interface TreeHandlers {
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onCreate: (path: string) => void;
}

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
  filePath: string | null;
}

function buildTree(project: Project): Node[] {
  const root: Node[] = [];
  const dirs = new Map<string, Node>();

  const dirNode = (path: string): Node[] => {
    if (path === '') return root;
    const hit = dirs.get(path);
    if (hit) return hit.children;
    const slash = path.lastIndexOf('/');
    const parent = dirNode(slash === -1 ? '' : path.slice(0, slash));
    const node: Node = { name: path.slice(slash + 1), path, dir: true, children: [], filePath: null };
    dirs.set(path, node);
    parent.push(node);
    return node.children;
  };

  for (const file of sortedFiles(project)) {
    const slash = file.path.lastIndexOf('/');
    const parent = dirNode(slash === -1 ? '' : file.path.slice(0, slash));
    if (isKeepFile(file.path)) continue; // marker only materializes the folder
    parent.push({
      name: file.path.slice(slash + 1),
      path: file.path,
      dir: false,
      children: [],
      filePath: file.path,
    });
  }

  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    for (const n of nodes) sort(n.children);
  };
  sort(root);
  return root;
}

function extTag(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return 'htm';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  return ext.slice(0, 3) || '···';
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|bmp|avif)$/i.test(path);
}

/** Inline create/rename input row used by the tree. */
function inputRow(initial: string, onCommit: (value: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tree-input';
  const input = document.createElement('input');
  input.value = initial;
  input.setAttribute('aria-label', 'File path');
  input.placeholder = 'folder/file.js';
  input.spellcheck = false;
  let done = false;
  const commit = (ok: boolean) => {
    if (done) return;
    done = true;
    if (ok) onCommit(input.value);
    row.remove();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  row.appendChild(input);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return row;
}

export function renderTree(el: HTMLElement, project: Project, activePath: string | null, handlers: TreeHandlers): void {
  el.replaceChildren();
  const list = document.createElement('ul');
  list.setAttribute('role', 'group');

  const nodes = buildTree(project);
  if (nodes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tree-empty';
    empty.textContent = 'Empty project — create a file, drop files anywhere, or import a .zip.';
    el.appendChild(empty);
    return;
  }

  const renderNodes = (parent: HTMLElement, items: Node[]) => {
    for (const node of items) {
      const li = document.createElement('li');
      if (node.dir) {
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-expanded', 'true');
        li.className = 'tree-folder';
        const row = document.createElement('div');
        row.className = 'tree-row';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `▸ ${node.name}`;
        row.appendChild(name);
        li.appendChild(row);
        const sub = document.createElement('ul');
        sub.setAttribute('role', 'group');
        renderNodes(sub, node.children);
        li.appendChild(sub);
      } else {
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-selected', node.filePath === activePath ? 'true' : 'false');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `tree-row${node.filePath === activePath ? ' active' : ''}`;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = isImagePath(node.filePath ?? '') ? 'img' : extTag(node.name);
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = node.name;
        name.title = node.filePath ?? '';
        const del = document.createElement('span');
        del.className = 'mini';
        del.setAttribute('role', 'button');
        del.setAttribute('tabindex', '0');
        del.textContent = '✕';
        del.title = 'Delete file';
        const armDelete = (e: Event) => {
          e.stopPropagation();
          if (del.classList.contains('danger-armed')) {
            handlers.onDelete(node.filePath ?? '');
          } else {
            del.classList.add('danger-armed');
            del.textContent = '?';
            del.title = 'Click again to confirm';
            window.setTimeout(() => {
              del.classList.remove('danger-armed');
              del.textContent = '✕';
            }, 2500);
          }
        };
        del.addEventListener('click', armDelete);
        del.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') armDelete(e);
        });
        row.append(tag, name, del);
        row.addEventListener('click', () => handlers.onSelect(node.filePath ?? ''));
        row.addEventListener('dblclick', () => {
          li.replaceChildren(inputRow(node.filePath ?? '', (v) => handlers.onRename(node.filePath ?? '', v)));
        });
        li.appendChild(row);
      }
      parent.appendChild(li);
    }
  };

  renderNodes(list, nodes);
  el.appendChild(list);
}

/** Show the "new file/folder" input at the top of the tree element. */
export function showCreateRow(el: HTMLElement, initial: string, handlers: TreeHandlers): void {
  const existing = el.querySelector('.tree-input');
  existing?.remove();
  el.prepend(inputRow(initial, (v) => handlers.onCreate(v)));
}
