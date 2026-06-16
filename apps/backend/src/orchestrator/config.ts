import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TigerConfig } from './types.js';

let tmpSeq = 0;

/**
 * Default Tiger configuration. Command templates + flags live here so Claude/Codex
 * invocation can be changed without touching orchestration code.
 *
 * Permission defaults are the AUTONOMOUS-but-sandboxed floor (claude `acceptEdits`,
 * codex `--ask-for-approval never --sandbox workspace-write`) so a background agent can
 * write its output + marker without a human to approve prompts. The fully unrestricted
 * modes (claude `dangerous`, codex `yolo`) are present but never selected by default.
 */
export function defaultTigerConfig(): TigerConfig {
  return {
    version: 1,
    cli: {
      claude: {
        executable: 'claude',
        modelFlag: '--model',
        effortFlag: '--effort',
        extraArgs: [],
        permissionModes: {
          default: [],
          acceptEdits: ['--permission-mode', 'acceptEdits'],
          plan: ['--permission-mode', 'plan'],
          dangerous: ['--dangerously-skip-permissions'],
        },
      },
      codex: {
        executable: 'codex',
        modelFlag: '-m',
        effortConfigKey: 'model_reasoning_effort',
        extraArgs: ['--no-alt-screen'],
        permissionModes: {
          'read-only': ['--ask-for-approval', 'never', '--sandbox', 'read-only'],
          'workspace-write': ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
          yolo: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      },
    },
    defaults: {
      claudeAgents: 1,
      codexAgents: 1,
      claudeModel: 'sonnet',
      codexModel: '',
      claudeEffort: 'medium',
      codexEffort: 'medium',
      claudePermission: 'acceptEdits',
      codexPermission: 'workspace-write',
      parallel: true,
    },
    timing: {
      readyIdleMs: 1500,
      readyMaxWaitMs: 20000,
      doneIdleMs: 60000,
      markerPollMs: 1500,
      agentTimeoutMs: 30 * 60 * 1000,
    },
    execution: { parallel: true, locking: true, maxConcurrent: 4 },
  };
}

/** Fill any missing fields from defaults so a partial/old config.json is always usable. */
export function normalizeConfig(parsed: unknown): TigerConfig {
  const def = defaultTigerConfig();
  if (!parsed || typeof parsed !== 'object') return def;
  const p = parsed as Partial<TigerConfig>;
  const pcli = (p.cli ?? {}) as Partial<TigerConfig['cli']>;
  return {
    version: typeof p.version === 'number' ? p.version : def.version,
    cli: {
      claude: { ...def.cli.claude, ...(pcli.claude ?? {}) },
      codex: { ...def.cli.codex, ...(pcli.codex ?? {}) },
    },
    defaults: { ...def.defaults, ...(p.defaults ?? {}) },
    timing: { ...def.timing, ...(p.timing ?? {}) },
    execution: { ...def.execution, ...(p.execution ?? {}) },
  };
}

/** Load tiger/config.json, normalizing/repairing it; returns defaults if missing or corrupt. */
export async function loadConfig(configFile: string): Promise<TigerConfig> {
  try {
    const raw = await fs.readFile(configFile, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultTigerConfig();
  }
}

/** Atomically persist the config (unique temp + rename, mirroring store/state.ts). */
export async function saveConfig(configFile: string, cfg: TigerConfig): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const tmp = `${configFile}.${process.pid}.${tmpSeq++}.tmp`;
  const data = JSON.stringify(cfg, null, 2);
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, configFile);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
