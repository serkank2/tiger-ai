// ---------------------------------------------------------------------------
// Best-effort completion/blocked/failed notifications for AI Team runs (Epic-4
// item 10). Two channels, both opt-in and both fail-safe:
//
//  - An OS desktop notification, cross-platform via the native CLI on each
//    platform (PowerShell toast on Windows, `osascript` on macOS, `notify-send`
//    on Linux). If the tool is missing it simply degrades to nothing.
//  - An optional webhook POST to a configured URL (JSON body), guarded behind the
//    `TEAM_NOTIFY_WEBHOOK` env var so it is off unless explicitly enabled.
//
// Nothing here ever throws into the run loop: every failure is swallowed and, at
// most, logged at debug level. Notifications are side-effects, not run state.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { logger } from '../obs/logger.js';

const log = logger.child({ mod: 'team-notify' });

/** The terminal run outcomes worth notifying about. */
export type NotifiableOutcome = 'completed' | 'blocked' | 'failed';

export interface RunOutcomeNotification {
  runId: string;
  name: string;
  outcome: NotifiableOutcome;
  message?: string;
  workspace?: string;
}

/** Read the webhook URL from config (env-gated; off unless explicitly set). */
function webhookUrl(): string | null {
  const raw = process.env.TEAM_NOTIFY_WEBHOOK?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether desktop notifications are enabled. OFF by default (spawning a native notifier is a
 * surprising side-effect, and we must not pop OS toasts during tests); opt in by setting
 * TEAM_NOTIFY_DESKTOP=1. Never enabled under NODE_ENV=test regardless.
 */
function desktopEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  return process.env.TEAM_NOTIFY_DESKTOP === '1' || process.env.TEAM_NOTIFY_DESKTOP === 'true';
}

/**
 * Fire all configured notifications for a terminal run outcome. Best-effort and
 * non-blocking: returns immediately and never rejects.
 */
export function notifyRunOutcome(input: RunOutcomeNotification): void {
  const title = `AI Team ${input.outcome}: ${input.name}`.slice(0, 120);
  const body = (input.message ?? `Run ${input.runId} ${input.outcome}.`).slice(0, 240);
  if (desktopEnabled()) void desktopNotify(title, body).catch(() => undefined);
  void postWebhook(input).catch(() => undefined);
}

/** Cross-platform desktop notification via the platform's native tool. */
async function desktopNotify(title: string, body: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const script = `display notification ${quoteAppleScript(body)} with title ${quoteAppleScript(title)}`;
      await runDetached('osascript', ['-e', script]);
    } else if (platform === 'win32') {
      // BurntToast is not guaranteed; use the built-in balloon tip via Windows Forms, which
      // ships with .NET on every Windows host. Single-quoted PS literals avoid interpolation.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$n = New-Object System.Windows.Forms.NotifyIcon;',
        '$n.Icon = [System.Drawing.SystemIcons]::Information;',
        '$n.Visible = $true;',
        `$n.BalloonTipTitle = ${quotePwsh(title)};`,
        `$n.BalloonTipText = ${quotePwsh(body)};`,
        '$n.ShowBalloonTip(5000); Start-Sleep -Seconds 6; $n.Dispose();',
      ].join(' ');
      await runDetached('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } else {
      // Linux / other: notify-send if present (degrades to nothing when absent).
      await runDetached('notify-send', [title, body]);
    }
  } catch (err) {
    log.debug('desktop notification failed', { err });
  }
}

/** POST the outcome as JSON to the configured webhook, when one is set. */
async function postWebhook(input: RunOutcomeNotification): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'team.run.outcome',
        runId: input.runId,
        name: input.name,
        outcome: input.outcome,
        message: input.message ?? null,
        workspace: input.workspace ?? null,
        at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    log.debug('webhook notification failed', { err });
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn a fire-and-forget child; resolves on spawn, never blocks on its output. */
function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', shell: false });
      child.on('error', () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quotePwsh(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
