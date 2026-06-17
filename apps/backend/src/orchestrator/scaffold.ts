import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TigerPaths, SCAFFOLD_DIRS } from './paths.js';
import { SYSTEM_PROMPT_FILES } from './prompt-files.js';
import { defaultTigerConfig, saveConfig } from './config.js';

const RUN_LOG_HEADER = `# Tiger Orchestration Run Log

This log records every orchestration stage and agent run: start/end times, agent type
and ID, the command used, the output path, completion method, success status, and any
failure reason or retry. All entries are written in English.
`;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: ensure the tiger root is inside a git repo (Codex expects one). Never throws. */
async function gitInitIfNeeded(root: string): Promise<void> {
  const run = (args: string[]): Promise<number | null> =>
    new Promise((resolve) => {
      try {
        const p = spawn('git', args, { cwd: root, stdio: 'ignore', windowsHide: true, shell: false });
        p.on('error', () => resolve(null));
        p.on('close', (code) => resolve(code));
      } catch {
        resolve(null);
      }
    });
  const inside = await run(['rev-parse', '--is-inside-work-tree']);
  if (inside === 0) return; // already in a repo (the workspace itself may be one)
  if (inside === null) return; // git unavailable — skip silently
  await run(['init']);
}

/**
 * Create (idempotently) the full tiger/ workspace tree, write the 7 English system
 * prompts, store the original project prompt verbatim, seed config.json (only if absent,
 * preserving user edits), and initialize the run log.
 *
 * Returns the resolved paths for the workspace.
 */
export async function ensureScaffold(workspace: string, projectPrompt: string): Promise<TigerPaths> {
  const paths = new TigerPaths(workspace);

  await fs.mkdir(paths.root, { recursive: true });
  for (const dir of SCAFFOLD_DIRS) {
    await fs.mkdir(path.join(paths.root, dir), { recursive: true });
  }

  // System prompts are authoritative — (re)write them on every initialize.
  for (const { filename, content } of SYSTEM_PROMPT_FILES) {
    await fs.writeFile(path.join(paths.systemPromptsDir, filename), content, 'utf8');
  }

  // Original project prompt, preserved verbatim — written ONLY if absent so a re-scaffold
  // never clobbers the user's original prompt (the sole file allowed to be non-English).
  if (!(await fileExists(paths.projectPromptFile))) {
    await fs.writeFile(paths.projectPromptFile, projectPrompt, 'utf8');
  }

  // Seed config only if missing, so user customizations survive re-initialization.
  if (!(await fileExists(paths.configFile))) {
    await saveConfig(paths.configFile, defaultTigerConfig());
  }

  if (!(await fileExists(paths.runLogFile))) {
    await fs.writeFile(paths.runLogFile, RUN_LOG_HEADER, 'utf8');
  }

  await gitInitIfNeeded(paths.root);

  return paths;
}
