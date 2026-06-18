import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { validateRoleConfig, type ValidatableRole } from './validate.js';

const config = defaultTigerConfig();

/** A valid baseline role; tests override one field at a time. */
function role(overrides: Partial<ValidatableRole> = {}): ValidatableRole {
  return {
    name: 'Developer',
    tool: 'claude',
    model: 'opus',
    effort: 'high',
    permission: 'dangerous',
    canWriteCode: true,
    requiredForSignoff: true,
    ...overrides,
  };
}

test('validateRoleConfig accepts a well-formed Claude role', () => {
  assert.equal(validateRoleConfig(role(), config), null);
});

test('validateRoleConfig accepts a Codex role using CLI-default model and effort', () => {
  const result = validateRoleConfig(
    role({ tool: 'codex', model: '', effort: '', permission: 'yolo' }),
    config,
  );
  assert.equal(result, null);
});

test('validateRoleConfig rejects an empty role name with a clear English error', () => {
  const msg = validateRoleConfig(role({ name: '   ' }), config);
  assert.ok(msg, 'expected an error message');
  assert.match(msg, /name must not be empty/i);
});

test('validateRoleConfig rejects an unknown CLI tool with a clear English error', () => {
  const msg = validateRoleConfig(role({ tool: 'gemini' }), config);
  assert.ok(msg, 'expected an error message');
  assert.match(msg, /tool must be one of/i);
});

test('validateRoleConfig rejects an unknown permission key with a clear English error', () => {
  const msg = validateRoleConfig(role({ permission: 'no-such-mode' }), config);
  assert.ok(msg, 'expected an error message');
  assert.match(msg, /permission .* is not a known/i);
});

test('validateRoleConfig rejects inherited Object.prototype names as permission keys', () => {
  // Regression: an own-key check must be used, not `in` (which walks the
  // prototype chain and would accept these as "known" permission modes).
  for (const permission of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const msg = validateRoleConfig(role({ permission }), config);
    assert.ok(msg, `expected an error message for permission "${permission}"`);
    assert.match(msg, /permission .* is not a known/i);
  }
});

test('validateRoleConfig rejects a model that is not in the configured list', () => {
  const msg = validateRoleConfig(role({ model: 'gpt-9-ultra' }), config);
  assert.ok(msg, 'expected an error message');
  assert.match(msg, /model .* is not a configured/i);
});

test('validateRoleConfig rejects an effort that is invalid for the tool', () => {
  const msg = validateRoleConfig(role({ effort: 'turbo' }), config);
  assert.ok(msg, 'expected an error message');
  assert.match(msg, /effort .* is not a valid/i);
});
