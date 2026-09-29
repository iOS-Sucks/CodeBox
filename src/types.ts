// CodeBox data model. Everything persists to localStorage — no cookies,
// no network. Binary files (images) are stored as data: URLs.

export interface CodeFile {
  id: string;
  /** Slash-separated relative path, e.g. "css/main.css". */
  path: string;
  content: string;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  files: CodeFile[];
  /** Path of the file currently open in the editor. */
  activePath: string | null;
  updatedAt: number;
}

export interface PersistedState {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
}
