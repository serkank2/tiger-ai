import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TeamPaths } from './paths.js';

const workspace = path.join(os.tmpdir(), 'tiger-team-paths');
const paths = TeamPaths.fromWorkspace(workspace);
const root = path.join(workspace, '.tiger');
const runId = 'run-123';
const turnId = 'turn-abc';

test('TeamPaths resolves absolute team-run files under .tiger/team/<runId>', () => {
  assert.equal(paths.teamsDir, path.join(root, 'team'));
  assert.equal(paths.runDir(runId), path.join(root, 'team', runId));
  assert.equal(paths.teamFile(runId), path.join(root, 'team', runId, 'team.json'));
  assert.equal(paths.conversationFile(runId), path.join(root, 'team', runId, 'conversation.jsonl'));
  assert.equal(paths.runtimeDir(runId), path.join(root, 'team', runId, '.runtime'));
  assert.equal(paths.turnPromptFile(runId, turnId), path.join(root, 'team', runId, '.runtime', `${turnId}.prompt.md`));
  assert.equal(paths.turnOutputFile(runId, turnId), path.join(root, 'team', runId, '.runtime', `${turnId}.output.md`));
  assert.equal(paths.turnMarkerFile(runId, turnId), path.join(root, 'team', runId, '.runtime', `${turnId}.done`));
});

test('TeamPaths.rel returns forward-slashed paths relative to the .tiger root', () => {
  assert.equal(paths.rel(paths.teamFile(runId)), `team/${runId}/team.json`);
  assert.equal(paths.rel(paths.conversationFile(runId)), `team/${runId}/conversation.jsonl`);
  assert.equal(paths.rel(paths.turnPromptFile(runId, turnId)), `team/${runId}/.runtime/${turnId}.prompt.md`);
  assert.equal(paths.rel(paths.turnOutputFile(runId, turnId)), `team/${runId}/.runtime/${turnId}.output.md`);
  assert.equal(paths.rel(paths.turnMarkerFile(runId, turnId)), `team/${runId}/.runtime/${turnId}.done`);
});
