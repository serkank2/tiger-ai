import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchCommand, isDangerousPermission } from './launch-command.js';
import { defaultTigerConfig } from './config.js';

const cfg = defaultTigerConfig();

test('claude command includes model, effort, and permission-mode flags', () => {
  const cmd = buildLaunchCommand(cfg, 'claude', { model: 'sonnet', effort: 'high', permission: 'acceptEdits' });
  assert.equal(cmd, 'claude --model sonnet --effort high --permission-mode acceptEdits');
});

test('claude default (normal) permission yields no permission flags', () => {
  const cmd = buildLaunchCommand(cfg, 'claude', { model: '', effort: '', permission: 'default' });
  assert.equal(cmd, 'claude');
});

test('claude dangerous mode uses --dangerously-skip-permissions', () => {
  const cmd = buildLaunchCommand(cfg, 'claude', { model: 'opus', effort: '', permission: 'dangerous' });
  assert.equal(cmd, 'claude --model opus --dangerously-skip-permissions');
});

test('codex command applies model, reasoning effort, sandbox and extra args', () => {
  const cmd = buildLaunchCommand(cfg, 'codex', { model: 'gpt-5', effort: 'high', permission: 'workspace-write' });
  assert.equal(
    cmd,
    'codex -m gpt-5 -c model_reasoning_effort=high --ask-for-approval never --sandbox workspace-write --no-alt-screen',
  );
});

test('codex with no model omits the model flag', () => {
  const cmd = buildLaunchCommand(cfg, 'codex', { model: '', effort: '', permission: 'read-only' });
  assert.equal(cmd, 'codex --ask-for-approval never --sandbox read-only --no-alt-screen');
});

test('isDangerousPermission flags only the unrestricted modes', () => {
  assert.equal(isDangerousPermission(cfg, 'claude', 'dangerous'), true);
  assert.equal(isDangerousPermission(cfg, 'claude', 'acceptEdits'), false);
  assert.equal(isDangerousPermission(cfg, 'codex', 'yolo'), true);
  assert.equal(isDangerousPermission(cfg, 'codex', 'workspace-write'), false);
});
