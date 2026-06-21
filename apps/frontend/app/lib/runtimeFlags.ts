const LIMIT_TOP_PANEL_OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

export function isLimitTopPanelEnabled(value: string | null | undefined): boolean {
  return !LIMIT_TOP_PANEL_OFF_VALUES.has(String(value ?? '').toLowerCase());
}
