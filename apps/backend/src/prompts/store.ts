import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resolvePromptPath, MAX_PROMPT_BYTES } from './paths.js';
import { parsePrompt } from './frontmatter.js';
import type { PromptSummary, PromptFile } from './types.js';

let tmpSeq = 0; // per-process counter for unique temp filenames (avoids symlink/concurrent clobber)

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export function versionOf(st: { mtimeMs: number; size: number }): string {
  return `${Math.round(st.mtimeMs)}:${st.size}`;
}

export async function ensurePromptsDir(): Promise<void> {
  await fs.mkdir(config.promptsDir, { recursive: true });
}

/** Recursively list .md prompts (skips symlinks, oversized files, non-.md). */
export async function listPrompts(): Promise<PromptSummary[]> {
  await ensurePromptsDir();
  const out: PromptSummary[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(path.join(dir, ent.name), rel);
        continue;
      }
      if (!ent.name.toLowerCase().endsWith('.md')) continue;
      const abs = path.join(dir, ent.name);
      const st = await fs.stat(abs);
      if (st.size > MAX_PROMPT_BYTES) continue;
      const { meta } = parsePrompt(await fs.readFile(abs, 'utf8'));
      out.push({ ...meta, path: rel, size: st.size, mtimeMs: st.mtimeMs, version: versionOf(st) });
    }
  }
  await walk(config.promptsDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readPrompt(rel: string): Promise<PromptFile> {
  const r = await resolvePromptPath(rel);
  if (!r.ok) throw httpErr(400, r.reason);
  const st = await fs.stat(r.abs).catch(() => {
    throw httpErr(404, 'prompt not found');
  });
  if (st.size > MAX_PROMPT_BYTES) throw httpErr(413, 'prompt too large');
  const content = await fs.readFile(r.abs, 'utf8');
  const { meta, body } = parsePrompt(content);
  return { ...meta, path: r.rel, content, body, size: st.size, mtimeMs: st.mtimeMs, version: versionOf(st) };
}

interface WriteOpts {
  create?: boolean;
  overwrite?: boolean;
  expectedVersion?: string;
}

export async function writePrompt(rel: string, content: string, opts: WriteOpts): Promise<PromptFile> {
  if (typeof content !== 'string') throw httpErr(400, 'content required');
  if (Buffer.byteLength(content, 'utf8') > MAX_PROMPT_BYTES) throw httpErr(413, 'prompt too large');
  const r = await resolvePromptPath(rel);
  if (!r.ok) throw httpErr(400, r.reason);

  const existing = await fs.stat(r.abs).catch(() => null);
  if (opts.create && existing && !opts.overwrite) throw httpErr(409, 'prompt already exists');
  if (!opts.create && !existing) throw httpErr(404, 'prompt not found'); // PUT must target an existing file
  if (opts.expectedVersion && existing && versionOf(existing) !== opts.expectedVersion) {
    throw httpErr(409, 'prompt changed on disk');
  }

  await fs.mkdir(path.dirname(r.abs), { recursive: true });
  // Unique temp name + exclusive create ('wx') so we never follow or clobber an
  // attacker-planted / concurrent `*.md.tmp` symlink; clean up on a failed rename.
  const tmp = `${r.abs}.${process.pid}.${tmpSeq++}.tmp`;
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, r.abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return readPrompt(r.rel);
}

export async function deletePrompt(rel: string): Promise<void> {
  const r = await resolvePromptPath(rel);
  if (!r.ok) throw httpErr(400, r.reason);
  await fs.unlink(r.abs).catch(() => {
    throw httpErr(404, 'prompt not found');
  });
}

export async function renamePrompt(from: string, to: string, opts: { overwrite?: boolean }): Promise<PromptFile> {
  const a = await resolvePromptPath(from);
  if (!a.ok) throw httpErr(400, `from: ${a.reason}`);
  const b = await resolvePromptPath(to);
  if (!b.ok) throw httpErr(400, `to: ${b.reason}`);
  if (!opts.overwrite && (await fs.stat(b.abs).catch(() => null))) throw httpErr(409, 'target already exists');
  await fs.mkdir(path.dirname(b.abs), { recursive: true });
  await fs.rename(a.abs, b.abs).catch(() => {
    throw httpErr(404, 'prompt not found');
  });
  return readPrompt(b.rel);
}
