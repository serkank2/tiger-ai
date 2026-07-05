import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { PLAN_RESULT_JSON_SCHEMA } from '../run/plan.js';
import { parseTurnResult, fallbackTurnResult, TURN_RESULT_JSON_SCHEMA } from './result.js';
import { getDriver } from './providers/registry.js';
import { runAgentTurn } from './runner.js';
import { SessionRegistry } from './session.js';
import { resolveCommand } from './spawn.js';

const cfg = defaultTigerConfig();

// --- TurnResult contract ---------------------------------------------------

test('parseTurnResult accepts direct JSON', () => {
  const parsed = parseTurnResult('{"status":"done","summary":"implemented the parser"}');
  assert.equal(parsed?.status, 'done');
  assert.equal(parsed?.summary, 'implemented the parser');
});

test('parseTurnResult accepts fenced JSON and trailing objects in prose', () => {
  const fenced = parseTurnResult('Here you go:\n```json\n{"status":"blocked","summary":"tests are red"}\n```\nthanks');
  assert.equal(fenced?.status, 'blocked');
  const trailing = parseTurnResult(
    'I did the work.\n{"status":"done","summary":"ok","followUpTasks":[{"title":"add docs"}]}',
  );
  assert.equal(trailing?.status, 'done');
  assert.equal(trailing?.followUpTasks?.[0]?.title, 'add docs');
});

test('parseTurnResult rejects garbage and wrong shapes', () => {
  assert.equal(parseTurnResult('no json here'), null);
  assert.equal(parseTurnResult('{"status":"maybe","summary":"x"}'), null);
  assert.equal(parseTurnResult('{"status":"done"}'), null);
  assert.equal(parseTurnResult(''), null);
  const fallback = fallbackTurnResult('free-form text', 'schema missing');
  assert.equal(fallback.status, 'blocked');
});

test('result schema requires only status+summary (small on purpose)', () => {
  assert.deepEqual(TURN_RESULT_JSON_SCHEMA.required, ['status', 'summary']);
});

// --- Claude driver -----------------------------------------------------------

test('claude driver builds headless argv with resume and schema', () => {
  const driver = getDriver('claude');
  const invocation = driver.buildInvocation(
    {
      prompt: 'do the thing',
      model: 'claude-fable-5',
      effort: 'high',
      permission: 'acceptEdits',
      resumeSessionId: 'sess-123',
      resultSchema: TURN_RESULT_JSON_SCHEMA,
    },
    cfg.cli.claude,
  );
  const args = invocation.args;
  assert.equal(invocation.command, cfg.cli.claude.executable);
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('stream-json'));
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-123']);
  assert.ok(args.includes('--json-schema'));
  assert.equal(invocation.stdinText, 'do the thing');
});

test('claude driver downgrades dangerous permission when not allowed', () => {
  const driver = getDriver('claude');
  const denied = driver.buildInvocation(
    { prompt: 'x', permission: 'dangerous', allowDangerous: false },
    cfg.cli.claude,
  );
  assert.ok(!denied.args.includes('--dangerously-skip-permissions'));
  assert.ok(denied.args.includes('acceptEdits'));
  const allowed = driver.buildInvocation(
    { prompt: 'x', permission: 'dangerous', allowDangerous: true },
    cfg.cli.claude,
  );
  assert.ok(allowed.args.includes('--dangerously-skip-permissions'));
});

test('claude parser normalizes the stream and captures the result', () => {
  const parser = getDriver('claude').createParser();
  const events = [
    ...parser.push('{"type":"system","subtype":"init","session_id":"abc"}'),
    ...parser.push('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'),
    ...parser.push(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file":"a.ts"}}]}}',
    ),
    ...parser.push('not json at all'),
    ...parser.push(
      '{"type":"result","subtype":"success","result":"{\\"status\\":\\"done\\",\\"summary\\":\\"ok\\"}","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":20},"session_id":"abc","is_error":false}',
    ),
  ];
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['turn-started', 'text', 'tool-use', 'raw', 'result']);
  const summary = parser.finish();
  assert.equal(summary.sessionId, 'abc');
  assert.equal(summary.usage?.costUsd, 0.42);
  assert.equal(parseTurnResult(summary.resultText)?.status, 'done');
});

// --- Codex driver ------------------------------------------------------------

test('codex driver builds exec argv with resume, schema file, and stdin prompt', () => {
  const driver = getDriver('codex');
  const scratch = path.join(os.tmpdir(), 'kaplan-test-scratch');
  const invocation = driver.buildInvocation(
    {
      prompt: 'fix the bug',
      permission: 'yolo',
      allowDangerous: false,
      resumeSessionId: 'thread-9',
      resultSchema: TURN_RESULT_JSON_SCHEMA,
      scratchDir: scratch,
    },
    cfg.cli.codex,
  );
  assert.deepEqual(invocation.args.slice(0, 3), ['exec', 'resume', 'thread-9']);
  assert.ok(invocation.args.includes('--json'));
  // yolo without the dangerous opt-in degrades to workspace-write sandbox.
  assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(invocation.args.includes('workspace-write'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdinText, 'fix the bug');
  assert.ok(invocation.resultFile?.endsWith('last-message.txt'));
  const schemaFile = Object.keys(invocation.preludeFiles ?? {})[0];
  assert.ok(schemaFile?.endsWith('output-schema.json'));
});

test('codex output schema is converted to OpenAI-strict form (all keys required, optionals nullable)', () => {
  const driver = getDriver('codex');
  const scratch = path.join(os.tmpdir(), 'kaplan-test-scratch-strict');
  const invocation = driver.buildInvocation(
    { prompt: 'plan', permission: 'read-only', resultSchema: PLAN_RESULT_JSON_SCHEMA, scratchDir: scratch },
    cfg.cli.codex,
  );
  const schemaJson = Object.values(invocation.preludeFiles ?? {})[0] ?? '';
  const schema = JSON.parse(schemaJson) as {
    required: string[];
    properties: Record<string, { type: unknown } & Record<string, unknown>>;
  };
  // Strict mode: every property key must be listed in `required`…
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  // …at every nesting level (this exact omission made the API reject the turn
  // with invalid_json_schema: "Missing 'id'").
  const items = (schema.properties.tasks as unknown as { items: typeof schema }).items;
  assert.deepEqual([...items.required].sort(), Object.keys(items.properties).sort());
  assert.equal((items as unknown as { additionalProperties: boolean }).additionalProperties, false);
  // Optional keys became nullable; required keys keep their exact type.
  assert.deepEqual(items.properties.id!.type, ['string', 'null']);
  assert.deepEqual(items.properties.dependsOn!.type, ['array', 'null']);
  assert.equal(items.properties.title!.type, 'string');
});

test('codex parser emits ONE result even when the CLI closes with error + turn.failed', () => {
  const parser = getDriver('codex').createParser();
  const events = [
    ...parser.push('{"type":"thread.started","thread_id":"t-9"}'),
    ...parser.push('{"type":"error","error":{"message":"invalid schema"}}'),
    ...parser.push('{"type":"turn.failed"}'),
  ];
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn-started', 'result'],
  );
  const summary = parser.finish();
  assert.equal(summary.isError, true);
  assert.equal(summary.errorDetail, 'invalid schema');
});

test('codex parser handles the NEW event generation', () => {
  const parser = getDriver('codex').createParser();
  const events = [
    ...parser.push('{"type":"thread.started","thread_id":"t-1"}'),
    ...parser.push('{"type":"item.completed","item":{"item_type":"reasoning","text":"thinking…"}}'),
    ...parser.push('{"type":"item.completed","item":{"item_type":"command_execution","command":"npm test"}}'),
    ...parser.push(
      '{"type":"item.completed","item":{"item_type":"assistant_message","text":"{\\"status\\":\\"done\\",\\"summary\\":\\"green\\"}"}}',
    ),
    ...parser.push('{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":9}}'),
  ];
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn-started', 'thinking', 'tool-use', 'text', 'result'],
  );
  const summary = parser.finish();
  assert.equal(summary.sessionId, 't-1');
  assert.equal(summary.usage?.outputTokens, 9);
  assert.equal(parseTurnResult(summary.resultText)?.summary, 'green');
});

test('codex parser handles the OLD msg-envelope generation', () => {
  const parser = getDriver('codex').createParser();
  const events = [
    ...parser.push('{"id":"0","msg":{"type":"session_configured","session_id":"s-7"}}'),
    ...parser.push('{"id":"1","msg":{"type":"agent_message","message":"done, all tests pass"}}'),
    ...parser.push('{"id":"2","msg":{"type":"token_count","input_tokens":11,"output_tokens":3}}'),
    ...parser.push('{"id":"3","msg":{"type":"task_complete","last_agent_message":"done, all tests pass"}}'),
  ];
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn-started', 'text', 'usage', 'result'],
  );
  const summary = parser.finish();
  assert.equal(summary.sessionId, 's-7');
  assert.equal(summary.resultText, 'done, all tests pass');
});

test('codex driver never inherits interactive-era tool extraArgs (--no-alt-screen regression)', () => {
  const driver = getDriver('codex');
  const tool = { ...cfg.cli.codex, extraArgs: ['--no-alt-screen'] };
  const invocation = driver.buildInvocation({ prompt: 'x', permission: 'workspace-write' }, tool);
  assert.ok(!invocation.args.includes('--no-alt-screen'));
  // Engine-supplied per-turn args still pass through.
  const withArgs = driver.buildInvocation({ prompt: 'x', extraArgs: ['--foo'] }, tool);
  assert.ok(withArgs.args.includes('--foo'));
});

// --- Antigravity driver --------------------------------------------------------

test('agy driver appends the result-file contract and honors conversation resume', () => {
  const driver = getDriver('antigravity');
  assert.equal(driver.supportsResume, false);
  const scratch = path.join(os.tmpdir(), 'kaplan-agy-scratch');
  const invocation = driver.buildInvocation(
    {
      prompt: 'review the diff',
      permission: 'dangerous',
      allowDangerous: true,
      resumeSessionId: 'conv-1',
      scratchDir: scratch,
    },
    cfg.cli.antigravity,
  );
  assert.ok(invocation.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf('--conversation'), invocation.args.indexOf('--conversation') + 2),
    ['--conversation', 'conv-1'],
  );
  const promptArg = invocation.args[invocation.args.indexOf('--print') + 1] ?? '';
  assert.ok(promptArg.startsWith('review the diff'));
  assert.ok(promptArg.includes('FINAL OUTPUT CONTRACT'));
  assert.ok(invocation.resultFile?.endsWith('agy-result.json'));
});

// --- Spawn resolution ---------------------------------------------------------

test('resolveCommand passes through non-windows and unresolvable names', () => {
  const resolved = resolveCommand('definitely-not-a-real-cli-xyz');
  assert.equal(resolved.file, 'definitely-not-a-real-cli-xyz');
  assert.equal(resolved.isBatch, false);
});

// --- TurnRunner end-to-end with a fake CLI --------------------------------------

const FAKE_CLI = `
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ status: 'done', summary: 'fake done' }), total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 }, session_id: 'fake-1', is_error: false }),
];
for (const l of lines) process.stdout.write(l + '\\n');
`;

test('runAgentTurn reports an honest failure on nonzero exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-runner-'));
  // node with claude's argv is a guaranteed bad invocation → nonzero exit.
  const tool = { ...cfg.cli.claude, executable: process.execPath };
  const report = await runAgentTurn({
    driver: getDriver('claude'),
    tool,
    request: { prompt: 'ignored', extraArgs: [] },
    cwd: dir,
    hardTimeoutMs: 30_000,
  });
  assert.equal(report.state, 'failed');
  assert.ok(report.error);
});

test('runAgentTurn happy path via a script provider', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-runner2-'));
  const script = path.join(dir, 'fake-claude.js');
  await fs.writeFile(script, FAKE_CLI, 'utf8');
  // Drive the fake through the claude driver by making the executable `node`
  // and prepending the script path via extraArgs — argv order for node is
  // `node script.js …claude-flags`, and the fake ignores the flags.
  const driver = getDriver('claude');
  const tool = { ...cfg.cli.claude, executable: process.execPath, extraArgs: [] };
  const events: string[] = [];
  const report = await runAgentTurn({
    driver: {
      ...driver,
      buildInvocation: (request, toolCfg) => {
        const built = driver.buildInvocation(request, toolCfg);
        return { ...built, args: [script] };
      },
    },
    tool,
    request: { prompt: 'hi' },
    cwd: dir,
    hardTimeoutMs: 30_000,
    onEvent: (event) => events.push(event.type),
  });
  assert.equal(report.state, 'completed');
  assert.equal(report.sessionId, 'fake-1');
  assert.equal(report.result?.status, 'done');
  assert.equal(report.usage?.costUsd, 0.01);
  assert.deepEqual(events, ['turn-started', 'text', 'result']);
});

test('runAgentTurn enforces the hard timeout by killing the tree', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-runner3-'));
  const script = path.join(dir, 'sleeper.js');
  await fs.writeFile(script, 'setInterval(() => {}, 1000);', 'utf8');
  const driver = getDriver('claude');
  const report = await runAgentTurn({
    driver: { ...driver, buildInvocation: () => ({ command: process.execPath, args: [script] }) },
    tool: cfg.cli.claude,
    request: { prompt: 'x' },
    cwd: dir,
    hardTimeoutMs: 1_500,
  });
  assert.equal(report.state, 'failed');
  assert.match(report.error ?? '', /hard timeout/);
});

test('runAgentTurn prefers the result file over stdout (agy contract)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-runner4-'));
  const resultFile = path.join(dir, 'agy-result.json');
  const script = path.join(dir, 'fake-agy.js');
  await fs.writeFile(
    script,
    `require('fs').writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ status: 'done', summary: 'from file' }));\n` +
      `process.stdout.write('garbled interleaved output');`,
    'utf8',
  );
  const driver = getDriver('antigravity');
  const report = await runAgentTurn({
    driver: { ...driver, buildInvocation: () => ({ command: process.execPath, args: [script], resultFile }) },
    tool: cfg.cli.antigravity,
    request: { prompt: 'x' },
    cwd: dir,
    hardTimeoutMs: 30_000,
  });
  assert.equal(report.state, 'completed');
  assert.equal(report.result?.summary, 'from file');
});

// --- SessionRegistry -----------------------------------------------------------

test('session registry persists ids and delta cursors atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-sessions-'));
  const file = path.join(dir, 'sessions.json');
  const registry = new SessionRegistry(file);
  await registry.load();
  await registry.upsert('run1:dev', 'claude', { sessionId: 's-1', lastSeq: 4, turnServed: true });
  await registry.upsert('run1:dev', 'claude', { lastSeq: 9, turnServed: true });

  const reloaded = new SessionRegistry(file);
  await reloaded.load();
  const stored = reloaded.get('run1:dev');
  assert.equal(stored?.sessionId, 's-1');
  assert.equal(stored?.lastSeq, 9);
  assert.equal(stored?.turns, 2);

  await reloaded.remove('run1:dev');
  assert.equal(reloaded.get('run1:dev'), undefined);
});
