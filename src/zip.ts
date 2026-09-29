import JSZip from 'jszip';
import { realFiles, sanitizePath } from './store.ts';
import type { Project } from './types.ts';

export interface ImportedFile {
  path: string;
  /** Text content, or a data: URL for images. */
  content: string;
}

const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'svg', 'xml', 'csv']);
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

export const MAX_ZIP_FILES = 400;
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_TOTAL_BYTES = 15_000_000;

function skipName(name: string): boolean {
  return (
    name.startsWith('__MACOSX/') ||
    name.endsWith('.DS_Store') ||
    name.startsWith('.git/') ||
    /(^|\/)\.git(\/|$)/.test(name)
  );
}

export function classifyName(path: string): 'text' | 'image' | 'unsupported' {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext in IMAGE_MIME) return 'image';
  return 'unsupported';
}

export async function importZip(blob: Blob): Promise<{ files: ImportedFile[]; skipped: string[] }> {
  const zip = await JSZip.loadAsync(blob);
  const files: ImportedFile[] = [];
  const skipped: string[] = [];
  let total = 0;

  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > MAX_ZIP_FILES) {
    throw new Error(`Zip holds ${entries.length} files (max ${MAX_ZIP_FILES}).`);
  }

  for (const entry of entries) {
    if (!entry.name) continue;
    if (skipName(entry.name)) continue;
    const path = sanitizePath(entry.name);
    if (!path) {
      skipped.push(entry.name);
      continue;
    }
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_EXT.has(ext) && !(ext in IMAGE_MIME)) {
      skipped.push(path);
      continue;
    }
    if (ext in IMAGE_MIME) {
      const base64 = await entry.async('base64');
      const content = `data:${IMAGE_MIME[ext]};base64,${base64}`;
      total += content.length;
      if (content.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Error('Zip is too large for browser storage — import fewer/smaller files.');
      }
      files.push({ path, content });
    } else {
      const content = await entry.async('string');
      total += content.length;
      if (content.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Error('Zip is too large for browser storage — import fewer/smaller files.');
      }
      files.push({ path, content });
    }
  }

  if (files.length === 0) throw new Error('No supported files found (HTML, CSS, JS, images).');
  return { files, skipped };
}

/** Download the project (minus folder markers) as a .zip file. */
export async function exportZip(project: Project): Promise<Blob> {
  const zip = new JSZip();
  for (const file of realFiles(project)) {
    if (file.content.startsWith('data:')) {
      const comma = file.content.indexOf(',');
      zip.file(file.path, file.content.slice(comma + 1), { base64: true });
    } else {
      zip.file(file.path, file.content);
    }
  }
  return zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
