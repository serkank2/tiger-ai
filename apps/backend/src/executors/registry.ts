import type { ProviderAdapter } from './types.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { antigravityAdapter } from './adapters/antigravity.js';
import { EXPERIMENTAL_ADAPTERS } from './adapters/experimental.js';

/**
 * Wired adapters: the real, user-selectable providers. Their ids MUST match the `AgentType`
 * union and the `cfg.cli` keys. Adding a provider = add an adapter here (or promote an
 * experimental one — see adapters/experimental.ts).
 */
const WIRED_ADAPTERS: ProviderAdapter[] = [claudeAdapter, codexAdapter, antigravityAdapter];

/**
 * The provider registry: id -> adapter. Experimental adapters are registered too (so they are
 * resolvable for tests/opt-in callers) but are flagged `experimental` and are NOT part of the
 * default user-selectable set. Promote one by moving it into WIRED_ADAPTERS and dropping its
 * `experimental` flag (full steps in adapters/experimental.ts).
 */
export const providerRegistry: ReadonlyMap<string, ProviderAdapter> = new Map(
  [...WIRED_ADAPTERS, ...EXPERIMENTAL_ADAPTERS].map((a) => [a.id, a]),
);

/** Resolve an adapter by id, throwing a clear error for an unknown provider. */
export function getAdapter(id: string): ProviderAdapter {
  const adapter = providerRegistry.get(id);
  if (!adapter) {
    const known = [...providerRegistry.keys()].join(', ');
    throw new Error(`Unknown provider "${id}". Known providers: ${known}.`);
  }
  return adapter;
}

/** Ids of the wired (non-experimental) providers, in registration order. */
export function wiredProviderIds(): string[] {
  return WIRED_ADAPTERS.map((a) => a.id);
}
