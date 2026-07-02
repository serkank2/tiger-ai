// Single source of truth for the application's top-level information architecture.
// The nav rail, route guards and tests all read this list so a new screen is
// added in exactly one place.

export interface NavItem {
  /** Stable identifier (used for keys and tests). */
  key: string;
  /** Route path the entry links to. */
  to: string;
  /**
   * Human label shown in the rail. This is the English fallback; localized UIs
   * translate via `labelKey` (see app/locales). Kept populated so non-i18n
   * consumers (and tests) still render a sensible default.
   */
  label: string;
  /** i18n message key (under the `nav.` namespace) used to localize `label`. */
  labelKey: string;
  /** Emoji glyph used as a lightweight icon. */
  icon: string;
  /** One-line description for tooltips / empty states. */
  hint: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'terminals',
    to: '/terminals',
    label: 'Terminals',
    labelKey: 'nav.terminals',
    icon: '🖥️',
    hint: 'Live terminal grid and command broadcast',
  },
  {
    key: 'runs',
    to: '/runs',
    label: 'Runs',
    labelKey: 'nav.runs',
    icon: '🚀',
    hint: 'v2 runs — headless agents over a work graph with engine-run checks',
  },
  {
    key: 'projects',
    to: '/tiger',
    label: 'Projects',
    labelKey: 'nav.projects',
    icon: '🐅',
    hint: 'Tiger AI software-team orchestrator',
  },
  {
    key: 'team',
    to: '/team',
    label: 'Team',
    labelKey: 'nav.team',
    icon: '👥',
    hint: 'AI Team — role agents that converse, build, and sign off',
  },
  {
    key: 'queue',
    to: '/queue',
    label: 'Queue',
    labelKey: 'nav.queue',
    icon: '📥',
    hint: 'Autonomous job queue with limit-aware dispatch',
  },
  {
    key: 'cue',
    to: '/cue',
    label: 'Cue',
    labelKey: 'nav.cue',
    icon: '🎬',
    hint: 'Event-driven orchestration — agents wake each other into pipelines',
  },
  {
    key: 'prompts',
    to: '/prompts',
    label: 'Prompts',
    labelKey: 'nav.prompts',
    icon: '💬',
    hint: 'Prompt history and generation',
  },
  {
    key: 'templates',
    to: '/templates',
    label: 'Templates',
    labelKey: 'nav.templates',
    icon: '🧩',
    hint: 'Run-all templates and presets',
  },
  {
    key: 'limits',
    to: '/limits',
    label: 'Limits',
    labelKey: 'nav.limits',
    icon: '📊',
    hint: 'Provider usage and limit management',
  },
  {
    key: 'settings',
    to: '/settings',
    label: 'Settings',
    labelKey: 'nav.settings',
    icon: '⚙️',
    hint: 'Preferences and system status',
  },
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
