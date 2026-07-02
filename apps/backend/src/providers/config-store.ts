import path from 'node:path';
import { config as appConfig } from '../config.js';
import { defaultTigerConfig, loadConfig, saveConfig, normalizeConfig } from '../orchestrator/config.js';
import type { TigerConfig } from '../orchestrator/types.js';

// ---------------------------------------------------------------------------
// Global provider CLI configuration (executables, model lists, permission
// modes, per-provider defaults). In v1 this lived per-Tiger-workspace under
// `tiger/config.json`, edited via the Tiger UI; with the Tiger engine retired
// it becomes ONE app-level file under the data dir. Missing/corrupt files
// normalize to the built-in defaults, so a fresh install needs no setup.
// ---------------------------------------------------------------------------

export class ProviderConfigStore {
  private cfg: TigerConfig = defaultTigerConfig();
  private loaded = false;

  constructor(private readonly file = path.join(appConfig.dataDir, 'providers.json')) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.cfg = await loadConfig(this.file);
  }

  /** The current normalized provider config (always usable; defaults when unset). */
  getConfig(): TigerConfig {
    return this.cfg;
  }

  /** Replace the config (normalized) and persist it. */
  async update(next: unknown): Promise<TigerConfig> {
    this.cfg = normalizeConfig(next);
    await saveConfig(this.file, this.cfg);
    return this.cfg;
  }
}
