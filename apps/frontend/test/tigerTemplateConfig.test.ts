import { describe, expect, it } from 'vitest';
import type { TigerConfig } from '~/types';
import { freshStageConfig, sanitizeStageConfig } from '~/lib/tigerTemplateConfig';

// A config that mirrors the backend's three-provider shape, including Antigravity (`agy`)
// whose models are human-readable labels with spaces and parentheses.
const config: TigerConfig = {
  version: 1,
  cli: {
    claude: {
      executable: 'claude',
      models: ['opus', 'sonnet'],
      modelFlag: '--model',
      effortFlag: '--effort',
      permissionModes: { default: [], dangerous: ['--dangerously-skip-permissions'] },
    },
    codex: {
      executable: 'codex',
      models: ['gpt-5.5'],
      modelFlag: '-m',
      effortConfigKey: 'model_reasoning_effort',
      permissionModes: { yolo: ['--dangerously-bypass-approvals-and-sandbox'] },
    },
    antigravity: {
      executable: 'agy',
      models: ['Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)'],
      modelFlag: '--model',
      permissionModes: { default: [], sandbox: ['--sandbox'], dangerous: ['--dangerously-skip-permissions'] },
    },
  },
  defaults: {
    claudeAgents: 1,
    codexAgents: 1,
    antigravityAgents: 0,
    claudeModel: 'opus',
    codexModel: 'gpt-5.5',
    antigravityModel: 'Gemini 3.1 Pro (High)',
    claudeEffort: 'xhigh',
    codexEffort: 'xhigh',
    antigravityEffort: '',
    claudePermission: 'dangerous',
    codexPermission: 'yolo',
    antigravityPermission: 'dangerous',
    parallel: true,
  },
  timing: {},
  execution: {
    parallel: true,
    locking: true,
    maxConcurrent: 2,
    lockTtlMs: 1,
    maxCorrectionCycles: 1,
    deleteTigerOnComplete: false,
  },
};

describe('tigerTemplateConfig Antigravity support', () => {
  it('freshStageConfig seeds Antigravity defaults (off by default)', () => {
    const cfg = freshStageConfig(config);
    expect(cfg.antigravityAgents).toBe(0);
    expect(cfg.antigravityModel).toBe('Gemini 3.1 Pro (High)');
    expect(cfg.antigravityEffort).toBe('');
    expect(cfg.antigravityPermission).toBe('dangerous');
  });

  it('sanitizeStageConfig preserves a valid Antigravity selection with a space/parenthesis model', () => {
    const cfg = sanitizeStageConfig(config, {
      antigravityAgents: 2,
      antigravityModel: 'Claude Sonnet 4.6 (Thinking)',
      antigravityPermission: 'sandbox',
    });
    expect(cfg.antigravityAgents).toBe(2);
    expect(cfg.antigravityModel).toBe('Claude Sonnet 4.6 (Thinking)');
    expect(cfg.antigravityPermission).toBe('sandbox');
  });

  it('sanitizeStageConfig drops an unknown Antigravity model and clamps an out-of-range count', () => {
    const cfg = sanitizeStageConfig(config, {
      antigravityAgents: 99,
      antigravityModel: 'Made Up Model',
      antigravityPermission: 'not-a-mode',
    });
    expect(cfg.antigravityAgents).toBe(8); // clamped to AGENT_COUNT_MAX
    expect(cfg.antigravityModel).toBe(''); // unknown -> CLI default
    expect(cfg.antigravityPermission).toBe('dangerous'); // unknown -> default permission
  });

  it('sanitizeStageConfig accepts antigravity as a merge agent', () => {
    const cfg = sanitizeStageConfig(config, { mergeAgent: 'antigravity' });
    expect(cfg.mergeAgent).toBe('antigravity');
  });
});
