import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { ensureScaffold } from '../orchestrator/scaffold.js';
import { PER_FILE_CAP, TOTAL_CONTEXT_CAP } from '../orchestrator/compose.js';
import type { AgentType, TigerConfig } from '../orchestrator/types.js';
import { buildLaunchCommand } from '../orchestrator/launch-command.js';
import { composeRoleTurnPrompt, type TeamRole } from './compose-turn.js';
import { appendTranscriptMessages, readTranscriptMessages, systemBlockerMessage } from './message-bus.js';
import { runRoleTurn } from './runner.js';
import { RoleCliSession } from './role-session.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator', 'fake-cli.mjs');

const role: TeamRole = {
  id: 'developer',
  name: 'Developer',
  agentType: 'codex',
  persona: 'You are a pragmatic implementation engineer.',
  responsibilities: ['Implement the assigned task.', 'Report blockers visibly.'],
};

function fakeConfig(mode: string, timing: Partial<TigerConfig['timing']> = {}): TigerConfig {
  const cfg = defaultTigerConfig();
  return {
    ...cfg,
    cli: {
      ...cfg.cli,
      codex: {
        ...cfg.cli.codex,
        executable: 'node',
        models: ['fake'],
        modelFlag: '',
        effortConfigKey: '',
        extraArgs: [FAKE, '--mode', mode],
        permissionModes: { test: [] },
      },
    },
    defaults: {
      ...cfg.defaults,
      codexModel: 'fake',
      codexEffort: '',
      codexPermission: 'test',
    },
    timing: {
      ...cfg.timing,
      readyIdleMs: 100,
      readyMaxWaitMs: 3000,
      doneIdleMs: 0,
      markerPollMs: 100,
      agentTimeoutMs: 5000,
      settleMaxWaitMs: 1000,
      submitDelayMs: 10,
      ...timing,
    },
  };
}

// Wires the claude CLI to the fake agent and exposes a 'probe' permission mode whose only argument
// ('--no-warnings', a node-safe flag the fake still runs under) is a marker token. The default
// permission ('base') maps to no extra args, so the token appears in the launch command only when a
// role's own agent.permission is honored.
function fakeClaudeConfig(): TigerConfig {
  const cfg = defaultTigerConfig();
  return {
    ...cfg,
    cli: {
      ...cfg.cli,
      claude: {
        ...cfg.cli.claude,
        executable: 'node',
        models: ['fake'],
        modelFlag: '',
        effortFlag: '',
        extraArgs: [FAKE, '--mode', 'team'],
        permissionModes: { base: [], probe: ['--no-warnings'] },
      },
    },
    defaults: {
      ...cfg.defaults,
      claudeModel: 'fake',
      claudeEffort: '',
      claudePermission: 'base',
    },
    timing: {
      ...cfg.timing,
      readyIdleMs: 100,
      readyMaxWaitMs: 3000,
      doneIdleMs: 0,
      markerPollMs: 100,
      agentTimeoutMs: 5000,
      settleMaxWaitMs: 1000,
      submitDelayMs: 10,
    },
  };
}

test('defaultTigerConfig raises and env-overrides the per-turn agent timeout', () => {
  const previous = process.env.KAPLAN_AGENT_TIMEOUT_MS;
  try {
    delete process.env.KAPLAN_AGENT_TIMEOUT_MS;
    assert.equal(defaultTigerConfig().timing.agentTimeoutMs, 60 * 60 * 1000);

    process.env.KAPLAN_AGENT_TIMEOUT_MS = '4200000';
    assert.equal(defaultTigerConfig().timing.agentTimeoutMs, 4_200_000);
  } finally {
    if (previous === undefined) delete process.env.KAPLAN_AGENT_TIMEOUT_MS;
    else process.env.KAPLAN_AGENT_TIMEOUT_MS = previous;
  }
});

test('runRoleTurn completes one fake role turn and appends a TeamMessage to the transcript', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-turn-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('team'),
      runId: 'team-run-1',
      role,
      assignedTask: { id: 'TASK-FAKE', title: 'Fake task', content: 'Emit one team message.' },
    });

    assert.equal(result.outcome.state, 'completed');
    assert.equal(result.outcome.completion, 'marker');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.from, 'developer');
    assert.equal(result.messages[0]?.kind, 'chat');
    assert.equal(result.messages[0]?.seq, 1);
    assert.match(result.messages[0]?.body ?? '', /Fake team role turn completed/);
    assert.equal(manager.getDefinition(result.terminalId)?.protected, true);

    const routed = await manager.routeInput(
      { mode: 'all' },
      'broadcast should not reach protected team terminals',
      { appendNewline: false, startTerminalOnSend: false },
    );
    assert.deepEqual(routed.failed, [{ termId: result.terminalId, code: 'PROTECTED' }]);

    const transcript = await readTranscriptMessages(paths, 'team-run-1');
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.body, result.messages[0]?.body);

    const turnLog = await fs.readFile(path.join(paths.root, 'team', 'team-run-1', 'turns.ndjson'), 'utf8');
    assert.match(turnLog, /"state":"completed"/);
    const artifactLog = await fs.readFile(path.join(paths.root, 'team', 'team-run-1', 'artifacts.ndjson'), 'utf8');
    assert.match(artifactLog, /"kind":"prompt"/);
    assert.match(artifactLog, /"kind":"output"/);
    assert.match(artifactLog, /"kind":"marker"/);
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn completes recoverable malformed output and appends a parse-warning system message', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-turn-warning-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('team-warning'),
      runId: 'team-run-warning',
      role,
      assignedTask: { id: 'TASK-WARN', title: 'Warn task', content: 'Emit recoverable malformed output.' },
    });

    assert.equal(result.outcome.state, 'completed');
    assert.equal(result.parsed.parseWarnings?.length, 1);
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0]?.kind, 'chat');
    assert.equal(result.messages[0]?.body, 'Recovered analysis block.');
    assert.equal(result.messages[1]?.body, 'Valid block still applied.');
    assert.equal(result.messages[2]?.from, 'system');
    assert.equal(result.messages[2]?.kind, 'system');
    assert.match(result.messages[2]?.body ?? '', /AnalysisSummary/);

    const transcript = await readTranscriptMessages(paths, 'team-run-warning');
    assert.equal(transcript.length, 3);
    assert.equal(transcript[2]?.kind, 'system');
    assert.match(transcript[2]?.body ?? '', /Some structured output blocks were skipped or normalized/);
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn still fails when completed output has zero valid TeamMessage blocks', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-turn-invalid-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('team-invalid-output'),
      runId: 'team-run-invalid-output',
      role,
      assignedTask: { id: 'TASK-INVALID', title: 'Invalid task', content: 'Emit invalid structured output.' },
    });

    assert.equal(result.outcome.state, 'failed');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.from, 'system');
    assert.equal(result.messages[0]?.kind, 'blocker');
    assert.match(result.messages[0]?.body ?? '', /output did not contain any TeamMessage blocks/);
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn builds the launch command from the role\'s own agent config, not just config defaults', async () => {
  // Regression guard for FINDING-005: runRoleTurn normalizes the role (dropping its
  // agent/model/effort/permission) before building the launch command. The launch params must still
  // be derived from the raw role so a role driven through its `agent` block keeps its per-role CLI
  // settings instead of silently falling back to config.defaults.
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-perrole-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    // The normal RoleInstance case: the role carries a full agent config and selects the 'probe'
    // permission mode, which differs from the default ('base') only by the '--no-warnings' marker.
    const roleWithAgent = {
      id: 'developer',
      name: 'Developer',
      persona: 'You are a pragmatic implementation engineer.',
      responsibilities: ['Implement the assigned task.'],
      agent: { tool: 'claude' as AgentType, model: '', effort: '', permission: 'probe' },
    };
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeClaudeConfig(),
      runId: 'team-run-perrole',
      role: roleWithAgent,
      assignedTask: { id: 'TASK-PERROLE', content: 'Emit one team message.' },
    });

    assert.equal(result.outcome.state, 'completed');
    // With the per-role permission honored the marker token is present; if it fell back to the
    // 'base' default the command would not contain it.
    assert.match(result.command, /--no-warnings/);
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn returns a failed outcome and system blocker when the CLI fails', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-fail-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('missing'),
      runId: 'team-run-fail',
      role,
      assignedTask: { id: 'TASK-FAIL', content: 'This turn should fail.' },
    });

    assert.equal(result.outcome.state, 'failed');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.from, 'system');
    assert.equal(result.messages[0]?.kind, 'blocker');
    assert.match(result.messages[0]?.body ?? '', /failed/i);

    const transcript = await readTranscriptMessages(paths, 'team-run-fail');
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.kind, 'blocker');
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn returns a failed outcome and system blocker when the CLI times out', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-timeout-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('hang', { agentTimeoutMs: 900, markerPollMs: 100 }),
      runId: 'team-run-timeout',
      role,
      assignedTask: { id: 'TASK-TIMEOUT', content: 'This turn should time out.' },
    });

    assert.equal(result.outcome.state, 'failed');
    assert.match(result.outcome.error ?? '', /timed out/i);
    assert.equal(result.messages[0]?.from, 'system');
    assert.equal(result.messages[0]?.kind, 'blocker');
    assert.match(result.messages[0]?.body ?? '', /timed out/i);
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('runRoleTurn parses a valid partial output file when the role times out', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-timeout-partial-'));
  const manager = new TerminalManager();
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const session = {
      isAlive: false,
      noteFed() {
        /* no-op */
      },
      async runPrompt(input: { outputPath: string }) {
        await fs.writeFile(
          input.outputPath,
          [
            '```TeamMessage',
            JSON.stringify(
              { kind: 'chat', to: 'lead', body: 'Partial QA result before timeout.', taskId: 'TASK-TIMEOUT' },
              null,
              2,
            ),
            '```',
            '```VerificationDirective',
            JSON.stringify(
              { command: 'npm test', exitCode: 1, outcome: 'failed', summary: 'Partial verification failed.' },
              null,
              2,
            ),
            '```',
            '',
          ].join('\n'),
          'utf8',
        );
        return { state: 'failed' as const, error: 'agent timed out before signaling completion', alive: false };
      },
    } as unknown as RoleCliSession;

    const result = await runRoleTurn({
      manager,
      paths,
      config: fakeConfig('hang', { agentTimeoutMs: 900, markerPollMs: 100 }),
      runId: 'team-run-timeout-partial',
      role,
      assignedTask: { id: 'TASK-TIMEOUT', content: 'This turn writes partial output then times out.' },
      session,
    });

    assert.equal(result.outcome.state, 'failed');
    assert.match(result.outcome.error ?? '', /timed out/i);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.from, 'developer');
    assert.equal(result.messages[0]?.kind, 'chat');
    assert.equal(result.messages[0]?.body, 'Partial QA result before timeout.');
    assert.equal(result.parsed.verificationDirectives.length, 1);
    assert.equal(result.parsed.verificationDirectives[0]?.outcome, 'failed');

    const transcript = await readTranscriptMessages(paths, 'team-run-timeout-partial');
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.body, 'Partial QA result before timeout.');
  } finally {
    await manager.killAll();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('composeRoleTurnPrompt windows transcript and assigned context with Tiger context caps', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-team-compose-'));
  try {
    const paths = await ensureScaffold(workspace, 'Build the AI team feature.');
    const runId = 'team-run-compose';
    await appendTranscriptMessages(paths, runId, [
      systemBlockerMessage({
        runId,
        turnId: 'prior-turn',
        content: `${'x'.repeat(PER_FILE_CAP + 5000)}TRANSCRIPT_TAIL_SHOULD_BE_CAPPED`,
      }),
    ]);

    const composed = await composeRoleTurnPrompt({
      paths,
      runId,
      turnId: 'turn-compose',
      role,
      outputPath: path.join(paths.root, 'team', runId, '.runtime', 'turn-compose.output.md'),
      markerPath: path.join(paths.root, 'team', runId, '.runtime', 'turn-compose.done'),
      assignedTask: {
        id: 'TASK-HUGE',
        content: `${'y'.repeat(TOTAL_CONTEXT_CAP + 5000)}TASK_TAIL_SHOULD_BE_CAPPED`,
      },
    });

    assert.ok(
      composed.size.characters <= TOTAL_CONTEXT_CAP + 20_000,
      `prompt should stay near the shared context cap, got ${composed.size.characters}`,
    );
    assert.doesNotMatch(composed.prompt, /TRANSCRIPT_TAIL_SHOULD_BE_CAPPED/);
    assert.doesNotMatch(composed.prompt, /TASK_TAIL_SHOULD_BE_CAPPED/);
    assert.match(composed.prompt, /truncated to respect Tiger context caps/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function loopPrompt(outputPath: string, markerPath: string): string {
  return [
    '# AUTOMATION CONTEXT',
    'Save your deliverable to exactly this file (absolute path):',
    `    ${outputPath}`,
    '',
    'COMPLETION SIGNAL: create this marker file and write the single word "done" into it:',
    `    ${markerPath}`,
    '',
  ].join('\n');
}

test('a persistent role session serves multiple prompts on one live CLI without relaunching', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-role-session-'));
  const manager = new TerminalManager();
  try {
    const config = fakeConfig('team-loop');
    const command = buildLaunchCommand(config, 'codex', { model: 'fake', effort: '', permission: 'test' });
    const termId = 'team-test-role';
    const now = new Date().toISOString();
    manager.upsertDefinition({
      id: termId,
      name: 'Developer',
      groupId: null,
      cwd: dir,
      initialCommand: command,
      shell: { kind: 'system-default' },
      protected: true,
      createdAt: now,
      updatedAt: now,
    });

    const session = new RoleCliSession({ manager, termId, tool: 'codex', timing: config.timing });
    const signal = new AbortController().signal;

    for (let i = 1; i <= 2; i += 1) {
      const promptPath = path.join(dir, `t${i}.prompt.md`);
      const outputPath = path.join(dir, `t${i}.out.md`);
      const markerPath = path.join(dir, `t${i}.done`);
      await fs.writeFile(promptPath, loopPrompt(outputPath, markerPath), 'utf8');
      const result = await session.runPrompt({ promptPath, outputPath, markerPath, signal });
      assert.equal(result.state, 'completed', `turn ${i} completed`);
      assert.equal(result.alive, true, `session still alive after turn ${i}`);
      assert.match(await fs.readFile(outputPath, 'utf8'), /Fake persistent turn done/);
    }
    // The single CLI served both prompts.
    assert.equal(session.turns, 2);
    assert.equal(session.isAlive, true);

    await session.dispose();
    assert.equal(session.isAlive, false);
  } finally {
    await manager.killAll().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
