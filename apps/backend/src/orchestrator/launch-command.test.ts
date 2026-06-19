import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchCommand, isDangerousPermission, shellQuote } from './launch-command.js';
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

test('default launch commands use the high-capability default profile', () => {
  const d = cfg.defaults;
  assert.equal(
    buildLaunchCommand(cfg, 'claude', {
      model: d.claudeModel,
      effort: d.claudeEffort,
      permission: d.claudePermission,
    }),
    'claude --model opus --effort xhigh --dangerously-skip-permissions',
  );
  assert.equal(
    buildLaunchCommand(cfg, 'codex', {
      model: d.codexModel,
      effort: d.codexEffort,
      permission: d.codexPermission,
    }),
    'codex -m gpt-5.5 -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox --no-alt-screen',
  );
});

test('isDangerousPermission flags only the unrestricted modes', () => {
  assert.equal(isDangerousPermission(cfg, 'claude', 'dangerous'), true);
  assert.equal(isDangerousPermission(cfg, 'claude', 'acceptEdits'), false);
  assert.equal(isDangerousPermission(cfg, 'codex', 'yolo'), true);
  assert.equal(isDangerousPermission(cfg, 'codex', 'workspace-write'), false);
});

test('antigravity quotes a space/parenthesis model label as one argument plus the dangerous flag', () => {
  const cmd = buildLaunchCommand(cfg, 'antigravity', {
    model: 'Gemini 3.1 Pro (High)',
    effort: '',
    permission: 'dangerous',
  });
  assert.equal(cmd, 'agy --model "Gemini 3.1 Pro (High)" --dangerously-skip-permissions');
});

test('antigravity default permission yields agy with just the quoted model, no perm flags', () => {
  const cmd = buildLaunchCommand(cfg, 'antigravity', {
    model: 'Claude Opus 4.6 (Thinking)',
    effort: '',
    permission: 'default',
  });
  assert.equal(cmd, 'agy --model "Claude Opus 4.6 (Thinking)"');
});

test('antigravity sandbox permission adds --sandbox', () => {
  const cmd = buildLaunchCommand(cfg, 'antigravity', { model: '', effort: '', permission: 'sandbox' });
  assert.equal(cmd, 'agy --sandbox');
});

test('antigravity ignores effort (no effort flag) even if one is passed', () => {
  const cmd = buildLaunchCommand(cfg, 'antigravity', {
    model: 'Gemini 3.5 Flash (Low)',
    effort: 'high',
    permission: 'default',
  });
  assert.equal(cmd, 'agy --model "Gemini 3.5 Flash (Low)"');
});

test('isDangerousPermission recognizes the antigravity dangerous mode', () => {
  assert.equal(isDangerousPermission(cfg, 'antigravity', 'dangerous'), true);
  assert.equal(isDangerousPermission(cfg, 'antigravity', 'sandbox'), false);
  assert.equal(isDangerousPermission(cfg, 'antigravity', 'default'), false);
});

test('shellQuote leaves simple flags/identifiers verbatim and quotes only what needs it', () => {
  assert.equal(shellQuote('--model'), '--model');
  assert.equal(shellQuote('gpt-5.5'), 'gpt-5.5');
  assert.equal(shellQuote('model_reasoning_effort=high'), 'model_reasoning_effort=high');
  assert.equal(shellQuote('Gemini 3.1 Pro (High)'), '"Gemini 3.1 Pro (High)"');
});

test('shellQuote escapes an embedded quote/backslash so it cannot terminate the argument', () => {
  // Defense in depth: even if an unvalidated value reaches the quoter, the embedded quote is
  // escaped rather than closing the string and injecting further tokens.
  assert.equal(shellQuote('a"b'), '"a\\"b"');
  assert.equal(shellQuote('a\\b'), '"a\\\\b"');
  assert.equal(shellQuote('x" ; rm -rf / #'), '"x\\" ; rm -rf / #"');
});
