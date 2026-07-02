import type { AgentType } from '../../orchestrator/types.js';
import type { ProviderDriver } from './types.js';
import { claudeDriver } from './claude.js';
import { codexDriver } from './codex.js';
import { antigravityDriver } from './antigravity.js';

/**
 * The wired headless drivers, keyed by the same provider ids the rest of the
 * app uses (`AgentType`). Adding a provider = write a driver + register it —
 * the same extension shape as the v1 executor registry, but for the machine
 * interface instead of interactive launches.
 */
const DRIVERS: Record<AgentType, ProviderDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
  antigravity: antigravityDriver,
};

export function getDriver(type: AgentType): ProviderDriver {
  return DRIVERS[type];
}

export function listDrivers(): ProviderDriver[] {
  return Object.values(DRIVERS);
}
