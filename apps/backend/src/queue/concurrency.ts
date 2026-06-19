import type { QueueProvider } from './types.js';

/**
 * Per-provider concurrency lanes. The scheduler historically leased one job at a time
 * globally; these limits let several providers run in parallel (e.g. 2 claude + 2 codex)
 * while still capping how many jobs of a single provider may run concurrently.
 *
 * Default is 1 per provider, which preserves the original single-at-a-time-per-provider
 * behaviour. Override per provider with the env vars below (integers, min 1):
 *   KAPLAN_QUEUE_CONCURRENCY_CLAUDE
 *   KAPLAN_QUEUE_CONCURRENCY_CODEX
 *   KAPLAN_QUEUE_CONCURRENCY_ANTIGRAVITY
 *   KAPLAN_QUEUE_CONCURRENCY_MIXED
 *
 * `mixed` jobs touch more than one provider, so they occupy their own lane.
 */
export type QueueProviderConcurrency = Record<QueueProvider, number>;

export const QUEUE_PROVIDERS: QueueProvider[] = ['claude', 'codex', 'antigravity', 'mixed'];

const DEFAULT_CONCURRENCY = 1;

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

/** Resolve the configured per-provider concurrency limits (env-driven, default 1 each). */
export function resolveProviderConcurrency(): QueueProviderConcurrency {
  return {
    claude: envLimit('KAPLAN_QUEUE_CONCURRENCY_CLAUDE', DEFAULT_CONCURRENCY),
    codex: envLimit('KAPLAN_QUEUE_CONCURRENCY_CODEX', DEFAULT_CONCURRENCY),
    antigravity: envLimit('KAPLAN_QUEUE_CONCURRENCY_ANTIGRAVITY', DEFAULT_CONCURRENCY),
    mixed: envLimit('KAPLAN_QUEUE_CONCURRENCY_MIXED', DEFAULT_CONCURRENCY),
  };
}

/** Count jobs currently occupying a provider lane (running, by provider). */
export function countRunningByProvider(jobs: ReadonlyArray<{ status: string; provider: QueueProvider }>): QueueProviderConcurrency {
  const counts: QueueProviderConcurrency = { claude: 0, codex: 0, antigravity: 0, mixed: 0 };
  for (const job of jobs) {
    if (job.status === 'running') counts[job.provider] += 1;
  }
  return counts;
}
