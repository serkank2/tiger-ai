import os from 'node:os';
import { nanoid } from 'nanoid';
import type { TerminalManager, ManagerOutputEvent } from '../terminal/TerminalManager.js';
import type { TerminalRuntimeStatus } from '../store/types.js';
import type { AgentType } from './types.js';

// ---------------------------------------------------------------------------
// Usage/limit probe. There is no non-interactive "usage" command for either CLI, so we briefly
// launch the interactive CLI in a trusted directory, send its usage/status command, capture the
// rendered panel from the PTY scrollback, strip ANSI, and regex out the headline figures. The full
// cleaned panel text is returned too, so the UI shows something even when the regex misses.
// ---------------------------------------------------------------------------

/** A single parsed usage/limit figure for the UI (label + percentage + reset time). */
export interface UsageEntry {
  label: string;
  percent: number;
  /** Whether `percent` is the portion used (Claude) or remaining (Codex). */
  metric: 'used' | 'left';
  reset: string | null;
}

export interface UsageProbe {
  type: AgentType;
  ok: boolean;
  /** Structured usage figures rendered by the UI. */
  entries: UsageEntry[];
  /** Cleaned (ANSI-stripped) tail of the usage/status panel (raw fallback view). */
  raw: string;
  /** Lines that look like usage/limit figures (best-effort regex extraction). */
  highlights: string[];
  error?: string;
  checkedAt: string;
}

interface ProbeSpec {
  command: string;
  sendKeys: string;
  captureMs: number;
}

// Configurable defaults. Edit here (or wire to config.json) to match the actual CLI commands.
// Codex runs inline (--no-alt-screen) so its panel lands cleanly in the PTY scrollback.
const PROBES: Record<AgentType, ProbeSpec> = {
  claude: { command: 'claude', sendKeys: '/usage', captureMs: 5000 },
  codex: { command: 'codex --no-alt-screen', sendKeys: '/status', captureMs: 6000 },
};

const READY_IDLE_MS = 1200;
const READY_MAX_MS = 9000;
const SETTLE_MAX_MS = 4000;
const PROBE_HARD_MS = 20000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07]*\x07|[\r\b]/g;

function stripAnsi(s: string): string {
  return s
    .replace(ANSI, '\n')
    .replace(/[⠀-⣿]/g, '') // braille spinner frames
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

const HIGHLIGHT = /(%|\blimit\b|\bused\b|\bremaining\b|\breset|\bquota\b|\bweekly\b|\bsession\b|\bcredits?\b|\brate\b)/i;

// Section boundaries / chrome: hitting one of these resets the accumulated label context so junk
// (headers, totals, command echoes) before a real "X limit:" label is discarded.
const NOISE =
  /^(gpt[\w.\-]*\s*default|default|esc\b|starting mcp|\(\d+s|settings|status\s+config|stats|total\b|usage:|what'?s|approximate|scanning|refreshing|last 24h|longer sessions|subagents|% of usage|usage$|credits\b|d to day|status ?line|configure|improve documentation|\/(status|usage)\b)/i;

const BAR = /[█▌░▊▉▎▏]/;

/**
 * Parse the cleaned panel text into structured entries. Walks lines, accumulating a small label
 * window; a "N% used/left" line emits an entry (labelled from the window) and a following
 * "resets ..." line attaches to it. Tolerant of the noisy, line-wrapped TUI output.
 */
export function parseEntries(text: string): UsageEntry[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[\s│|>•·*─-]+/, '').replace(/[\s│|]+$/, '').trim())
    .filter(Boolean);

  const labelWindow: string[] = [];
  const entries: UsageEntry[] = [];
  for (const l of lines) {
    // A bar-only line (no percentage) is decoration — ignore it without clearing the label.
    if (BAR.test(l) && !/\d+\s*%/.test(l)) continue;

    const pm = l.match(/(\d+)\s*%\s*(used|left)\b/i);
    if (pm) {
      const label = labelWindow.join(' ').replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
      entries.push({
        label: label || 'Usage',
        percent: Math.max(0, Math.min(100, Number(pm[1]))),
        metric: pm[2]!.toLowerCase() as 'used' | 'left',
        reset: null,
      });
      labelWindow.length = 0;
      continue;
    }
    if (/resets?\b/i.test(l)) {
      const last = entries[entries.length - 1];
      if (last && !last.reset) last.reset = l.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim();
      labelWindow.length = 0;
      continue;
    }
    // Boundary lines (chrome, money, command echoes, letterless borders) reset the label context.
    if (NOISE.test(l) || /\$/.test(l) || /^[/›»>·~]/.test(l) || !/[a-z]/i.test(l)) {
      labelWindow.length = 0;
      continue;
    }
    // Accumulate short alphabetic lines as label context.
    if (l.length <= 40) {
      labelWindow.push(l.replace(/:$/, ''));
      if (labelWindow.length > 4) labelWindow.shift();
    }
  }

  // De-duplicate identical figures and cap.
  const seen = new Set<string>();
  const out: UsageEntry[] = [];
  for (const e of entries) {
    const key = `${e.label}|${e.percent}|${e.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= 8) break;
  }
  return out;
}

/** Keep usage figures (lines with a number) and short labels (e.g. "5h limit:"); drop prose noise. */
function extractHighlights(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const l = rawLine.replace(/^[\s│|>•·*─-]+/, '').replace(/[\s│|]+$/, '').trim();
    if (!l || l.length > 160) continue;
    if (!HIGHLIGHT.test(l)) continue;
    const hasNumber = /\d/.test(l);
    const isLabel = /:$/.test(l) && l.length <= 40;
    if (!hasNumber && !isLabel) continue; // skip single-word/prose noise
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= 16) break;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Probe one CLI's usage panel. Never throws — returns ok:false with a reason on failure. */
export async function probeUsage(manager: TerminalManager, type: AgentType, cwd?: string): Promise<UsageProbe> {
  const spec = PROBES[type];
  const checkedAt = new Date().toISOString();
  const termId = `usage-${type}-${nanoid(8)}`;
  const workdir = cwd && cwd.trim() ? cwd : os.homedir();

  const st = { lastOut: Date.now(), sawOut: false, exited: false };
  const onOut = (e: ManagerOutputEvent) => {
    if (e.termId === termId) {
      st.lastOut = Date.now();
      st.sawOut = true;
    }
  };
  const onExit = (s: TerminalRuntimeStatus) => {
    if (s.id === termId) st.exited = true;
  };
  manager.on('output', onOut);
  manager.on('exit', onExit);

  const waitIdle = async (idleMs: number, maxMs: number): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (st.exited) return;
      if (st.sawOut && Date.now() - st.lastOut >= idleMs) return;
      await sleep(150);
    }
  };

  const deadline = Date.now() + PROBE_HARD_MS;
  try {
    const now = new Date().toISOString();
    manager.upsertDefinition({
      id: termId,
      name: termId,
      groupId: null,
      cwd: workdir,
      initialCommand: spec.command,
      shell: { kind: 'system-default' },
      protected: true,
      createdAt: now,
      updatedAt: now,
    });
    await manager.start(termId);

    await waitIdle(READY_IDLE_MS, READY_MAX_MS);
    // Accept a first-run "trust this folder" dialog / focus the input.
    manager.write(termId, '\r');
    await waitIdle(800, SETTLE_MAX_MS);
    if (Date.now() > deadline) throw new Error('probe timed out before sending command');

    // Send the command twice: Codex's /status refreshes limits asynchronously ("run /status again
    // shortly"), and a re-send is harmless for Claude's /usage (it just re-renders).
    manager.write(termId, spec.sendKeys + '\r');
    await sleep(Math.floor(spec.captureMs / 2));
    manager.write(termId, spec.sendKeys + '\r');
    await sleep(Math.floor(spec.captureMs / 2));

    const raw = stripAnsi(manager.getBuffer(termId));
    const entries = parseEntries(raw);
    const highlights = extractHighlights(raw);
    return {
      type,
      ok: entries.length > 0 || raw.trim().length > 0,
      entries,
      raw: tail(raw, 4000),
      highlights,
      checkedAt,
    };
  } catch (err) {
    return {
      type,
      ok: false,
      entries: [],
      raw: '',
      highlights: [],
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  } finally {
    manager.off('output', onOut);
    manager.off('exit', onExit);
    await manager.remove(termId).catch(() => {});
  }
}

/** Probe both CLIs concurrently. */
export async function probeAllUsage(
  manager: TerminalManager,
  cwd?: string,
): Promise<{ claude: UsageProbe; codex: UsageProbe }> {
  const [claude, codex] = await Promise.all([probeUsage(manager, 'claude', cwd), probeUsage(manager, 'codex', cwd)]);
  return { claude, codex };
}
