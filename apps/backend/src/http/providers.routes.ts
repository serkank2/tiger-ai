import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { badRequest } from './errors.js';
import { effortsForProvider, isLaunchSafeModel } from '../orchestrator/config.js';
import type { AgentType, TigerConfig } from '../orchestrator/types.js';

/**
 * Provider CLI configuration surface. With the Tiger config screen retired,
 * this is how the UI edits the app-level `providers.json` (executables +
 * per-provider default model/effort/permission). The payload is a narrow,
 * purpose-built patch — validated field by field, never trusted raw — because
 * these values end up on agent command lines.
 */
export function createProvidersRouter(ctx: AppCtx): Router {
  const router = Router();
  const PROVIDERS: AgentType[] = ['claude', 'codex', 'antigravity'];

  router.get('/config', (_req, res) => {
    res.json({ config: publicConfig(ctx.providerConfig.getConfig()) });
  });

  router.put('/config', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = ctx.providerConfig.getConfig();
    // Deep-clone the current config, then apply the validated patch onto it.
    const next: TigerConfig = structuredClone(current);

    for (const provider of PROVIDERS) {
      const patch = body[provider];
      if (patch === undefined) continue;
      if (typeof patch !== 'object' || patch === null) throw badRequest(`${provider} must be an object`);
      const record = patch as Record<string, unknown>;

      if (record.executable !== undefined) {
        if (
          typeof record.executable !== 'string' ||
          !/^[\w.\- \\/:]+$/.test(record.executable.trim()) ||
          !record.executable.trim()
        ) {
          throw badRequest(`${provider}.executable is not a safe executable path`);
        }
        next.cli[provider].executable = record.executable.trim();
      }
      if (record.model !== undefined) {
        if (typeof record.model !== 'string' || !isLaunchSafeModel(provider, record.model.trim())) {
          throw badRequest(`${provider}.model is not a valid model identifier`);
        }
        setDefault(next, provider, 'Model', record.model.trim());
      }
      if (record.effort !== undefined) {
        if (typeof record.effort !== 'string' || !effortsForProvider(provider).includes(record.effort.trim())) {
          throw badRequest(`${provider}.effort is not a valid ${provider} effort`);
        }
        setDefault(next, provider, 'Effort', record.effort.trim());
      }
      if (record.permission !== undefined) {
        if (
          typeof record.permission !== 'string' ||
          !Object.prototype.hasOwnProperty.call(next.cli[provider].permissionModes, record.permission.trim())
        ) {
          throw badRequest(`${provider}.permission is not a known ${provider} permission mode`);
        }
        setDefault(next, provider, 'Permission', record.permission.trim());
      }
    }

    const saved = await ctx.providerConfig.update(next);
    res.json({ config: publicConfig(saved) });
  });

  return router;
}

type DefaultField = 'Model' | 'Effort' | 'Permission';

function setDefault(cfg: TigerConfig, provider: AgentType, field: DefaultField, value: string): void {
  const key = `${provider}${field}` as keyof TigerConfig['defaults'];
  (cfg.defaults as unknown as Record<string, unknown>)[key] = value;
}

/** The UI-facing shape: per provider, what is editable + the option lists. */
function publicConfig(cfg: TigerConfig) {
  const provider = (type: AgentType) => ({
    executable: cfg.cli[type].executable,
    model: String((cfg.defaults as unknown as Record<string, unknown>)[`${type}Model`] ?? ''),
    effort: String((cfg.defaults as unknown as Record<string, unknown>)[`${type}Effort`] ?? ''),
    permission: String((cfg.defaults as unknown as Record<string, unknown>)[`${type}Permission`] ?? ''),
    models: cfg.cli[type].models ?? [],
    efforts: [...effortsForProvider(type)],
    permissionModes: Object.keys(cfg.cli[type].permissionModes),
  });
  return { claude: provider('claude'), codex: provider('codex'), antigravity: provider('antigravity') };
}
