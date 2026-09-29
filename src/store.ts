import type { CodeFile, PersistedState, Project } from './types.ts';

export const STORAGE_KEY = 'codebox.projects.v1';
// Stay comfortably under the ~5MB localStorage quota browsers enforce.
export const MAX_BYTES = 4_500_000;
/** Marker that materializes an otherwise-empty folder. Never exported. */
export const KEEP_NAME = '.keep';

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Normalize a user-supplied path. Returns null when the path is unusable. */
export function sanitizePath(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  if (!cleaned || cleaned.length > 180) return null;
  const parts = cleaned.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export function emptyState(): PersistedState {
  return { version: 1, projects: [], activeProjectId: null };
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export function storageBytes(state: PersistedState): number {
  return new Blob([JSON.stringify(state)]).size;
}

export function persist(state: PersistedState): { ok: boolean; bytes: number } {
  const bytes = storageBytes(state);
  if (bytes > MAX_BYTES) return { ok: false, bytes };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true, bytes };
  } catch {
    return { ok: false, bytes };
  }
}

export function getProject(state: PersistedState, id: string | null): Project | null {
  if (!id) return null;
  return state.projects.find((p) => p.id === id) ?? null;
}

export function getFile(project: Project, path: string | null): CodeFile | null {
  if (!path) return null;
  return project.files.find((f) => f.path === path) ?? null;
}

export function isKeepFile(path: string): boolean {
  return path === KEEP_NAME || path.endsWith(`/${KEEP_NAME}`);
}

/** Real files only: folder markers never reach preview/export. */
export function realFiles(project: Project): CodeFile[] {
  return project.files.filter((f) => !isKeepFile(f.path));
}

export function sortedFiles(project: Project): CodeFile[] {
  return [...project.files].sort((a, b) => a.path.localeCompare(b.path));
}

export function createProject(name: string): Project {
  const now = Date.now();
  return { id: uid(), name: name.trim() || 'Untitled', files: [], activePath: null, updatedAt: now };
}

export function upsertFile(project: Project, path: string, content: string): CodeFile {
  const now = Date.now();
  const existing = getFile(project, path);
  if (existing) {
    existing.content = content;
    existing.updatedAt = now;
    project.updatedAt = now;
    return existing;
  }
  const file: CodeFile = { id: uid(), path, content, updatedAt: now };
  project.files.push(file);
  project.updatedAt = now;
  return file;
}
