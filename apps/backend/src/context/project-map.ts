import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Budgeted project map (Aider-lite). One compact, ranked view of the repo that
// is built ONCE per run and included ONCE per session — so agents stop
// re-discovering the tree with ls/glob calls on every turn. Sources file paths
// from `git ls-files` (respects .gitignore) with an fs-walk fallback, groups
// by directory, ranks directories by file count, and truncates to a hard
// character budget. Deliberately dependency-free: no tree-sitter — path + size
// signal captures most of the navigation value at ~zero cost.
// ---------------------------------------------------------------------------

export interface ProjectMapOptions {
  /** Hard output budget in characters (default 6000 ≈ 1.5k tokens). */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 6000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.nuxt', '.output', 'coverage', '.tiger']);

export async function buildProjectMap(workspace: string, opts: ProjectMapOptions = {}): Promise<string> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const files = (await gitListFiles(workspace)) ?? (await walkFiles(workspace));
  if (!files.length) return '(empty workspace)';

  // Group by top-2-level directory; rank groups by file count.
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split('/');
    const key = parts.length <= 2 ? (parts.length === 1 ? '.' : (parts[0] ?? '.')) : parts.slice(0, 2).join('/');
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [`Project map (${files.length} tracked files):`];
  for (const [dir, dirFiles] of ranked) {
    lines.push(`\n${dir}/ — ${dirFiles.length} files`);
    // Show up to 12 entries per group; prioritize source-looking files.
    const shown = dirFiles.sort((a, b) => sourceWeight(b) - sourceWeight(a) || a.localeCompare(b)).slice(0, 12);
    for (const file of shown) lines.push(`  ${file}`);
    if (dirFiles.length > shown.length) lines.push(`  … +${dirFiles.length - shown.length} more`);
  }

  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (map truncated to budget)` : text;
}

function sourceWeight(file: string): number {
  if (/\.(ts|tsx|vue|rs|go|py|java|cs)$/.test(file)) return 3;
  if (/\.(js|mjs|cjs|jsx|json)$/.test(file)) return 2;
  if (/\.(md|yml|yaml|toml)$/.test(file)) return 1;
  return 0;
}

/** `git ls-files` via discrete argv; null when not a git repo / git missing. */
async function gitListFiles(workspace: string): Promise<string[] | null> {
  return await new Promise((resolve) => {
    const child = spawn('git', ['ls-files'], { cwd: workspace, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const files = Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(files);
    });
  });
}

/** Non-git fallback: shallow walk (3 levels), skipping the usual heavy dirs. */
async function walkFiles(workspace: string, depth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, level: number, prefix: string): Promise<void> => {
    if (level > depth || out.length > 2000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), level + 1, rel);
      else out.push(rel);
    }
  };
  await walk(workspace, 1, '');
  return out;
}
