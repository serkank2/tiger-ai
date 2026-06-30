import test from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTION_STATUSES, REVIEW_STATUSES, FINAL_DECISIONS } from './types.js';

// Safety/spec test: the status vocabularies must match the original prompt EXACTLY,
// with no synonyms or extra values (TASK-002 / TASK-036).

test('execution status vocabulary matches the spec exactly', () => {
  assert.deepEqual([...EXECUTION_STATUSES].sort(), ['blocked', 'done', 'in_progress', 'not_started']);
});

test('review status vocabulary matches the spec exactly', () => {
  assert.deepEqual([...REVIEW_STATUSES].sort(), ['approved', 'fixed', 'needs_fix', 'pending', 'reviewing']);
});

test('final decision vocabulary matches the spec exactly', () => {
  assert.deepEqual([...FINAL_DECISIONS].sort(), [
    'approved',
    'major_fixes_required',
    'minor_fixes_required',
    'rejected',
  ]);
});
