// Single source of truth for the application's top-level information architecture.
// The nav rail, route guards and tests all read this list so a new screen is
// added in exactly one place.

export interface NavItem {
  /** Stable identifier (used for keys and tests). */
  key: string;
  /** Route path the entry links to. */
  to: string;
  /** Human label shown in the rail. */
  label: string;
  /** Emoji glyph used as a lightweight icon. */
  icon: string;
  /** One-line description for tooltips / empty states. */
  hint: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'terminals', to: '/terminals', label: 'Terminals', icon: '🖥️', hint: 'Live terminal grid and command broadcast' },
  { key: 'projects', to: '/tiger', label: 'Projects', icon: '🐅', hint: 'Tiger AI software-team orchestrator' },
  { key: 'team', to: '/team', label: 'Team', icon: '👥', hint: 'AI Team — role agents that converse, build, and sign off' },
  { key: 'queue', to: '/queue', label: 'Queue', icon: '📥', hint: 'Autonomous job queue with limit-aware dispatch' },
  { key: 'prompts', to: '/prompts', label: 'Prompts', icon: '💬', hint: 'Prompt history and generation' },
  { key: 'templates', to: '/templates', label: 'Templates', icon: '🧩', hint: 'Run-all templates and presets' },
  { key: 'limits', to: '/limits', label: 'Limits', icon: '📊', hint: 'Provider usage and limit management' },
  { key: 'settings', to: '/settings', label: 'Settings', icon: '⚙️', hint: 'Preferences and system status' },
];

/** Resolve the active nav entry for a given route path (longest matching prefix). */
export function activeNavKey(path: string): string | null {
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    if (path === item.to || path.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best?.key ?? null;
}
