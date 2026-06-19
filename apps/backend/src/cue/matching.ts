import type { CueEventPayload, CueFilter, CueSubscription } from './types.js';

/**
 * Decide whether an event payload satisfies a subscription's filter. Pure: no I/O, no fan-in
 * state (fan-in is accounted separately in fanin.ts). Unset filter fields are wildcards.
 */
export function matchesFilter(sub: CueSubscription, payload: CueEventPayload): boolean {
  if (sub.event !== payload.event) return false;
  if (sub.enabled === false) return false;
  const filter = sub.filter;
  if (!filter) return true;

  if (sub.event === 'file.changed') return matchesFileFilter(filter, payload);
  if (sub.event === 'agent.completed') return matchesAgentFilter(filter, payload);
  return true;
}

function matchesFileFilter(filter: CueFilter, payload: CueEventPayload): boolean {
  if (filter.changeType && filter.changeType !== 'any') {
    if (payload.changeType && payload.changeType !== filter.changeType) return false;
  }
  if (filter.pathIncludes) {
    const path = payload.filePath ?? '';
    if (!pathMatches(path, filter.pathIncludes)) return false;
  }
  return true;
}

function matchesAgentFilter(filter: CueFilter, payload: CueEventPayload): boolean {
  if (filter.triggeredBy) {
    // payload.extra.triggeredBy carries the orchestrator source ('team' | 'tiger').
    const by = payload.extra?.triggeredBy;
    if (by && by !== filter.triggeredBy) return false;
  }
  return true;
}

/**
 * Lightweight path matcher: a `*`-bearing pattern is treated as a glob over the whole path
 * (only `*` and `?` are special); otherwise it is a plain case-insensitive substring test.
 * Paths are normalized to forward slashes so a pattern works on Windows and POSIX alike.
 */
export function pathMatches(rawPath: string, pattern: string): boolean {
  const path = rawPath.replace(/\\/g, '/').toLowerCase();
  const pat = pattern.replace(/\\/g, '/').toLowerCase();
  if (!pat.includes('*') && !pat.includes('?')) return path.includes(pat);
  const re = new RegExp(
    '^.*' +
      pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '.*$',
  );
  return re.test(path);
}
