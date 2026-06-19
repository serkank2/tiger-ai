import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isWorkspaceAllowed } from './workspace.js';

// Use platform-native absolute roots so the tests are correct on both Windows and POSIX.
const ROOT = path.resolve('/srv/projects');
const DATA = path.resolve('/var/kaplan');
const ALLOW = [ROOT];

test('allows a directory inside an allow-listed root when enforcing', () => {
  const r = isWorkspaceAllowed(path.join(ROOT, 'app'), ALLOW, DATA, true);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.path, path.resolve(path.join(ROOT, 'app')));
});

test('allows the allow-listed root itself', () => {
  const r = isWorkspaceAllowed(ROOT, ALLOW, DATA, true);
  assert.equal(r.ok, true);
});

test('allows a directory inside the data dir even if not in the allowlist', () => {
  const r = isWorkspaceAllowed(path.join(DATA, 'runs', 'x'), ALLOW, DATA, true);
  assert.equal(r.ok, true);
});

test('rejects a directory outside every allowed root when enforcing', () => {
  const r = isWorkspaceAllowed(path.resolve('/etc'), ALLOW, DATA, true);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && /outside the allowed/.test(r.reason), true);
});

test('rejects a path-traversal escape out of an allowed root', () => {
  // Resolves to the parent of ROOT, which is not contained by ROOT or DATA.
  const escape = path.join(ROOT, '..', '..', 'etc', 'passwd');
  const r = isWorkspaceAllowed(escape, ALLOW, DATA, true);
  assert.equal(r.ok, false);
});

test('does not match a partial-segment sibling (/srv/projects vs /srv/projects-evil)', () => {
  const sibling = path.resolve('/srv/projects-evil');
  const r = isWorkspaceAllowed(sibling, ALLOW, DATA, true);
  assert.equal(r.ok, false);
});

test('passthrough: enforcement off allows any sane absolute dir', () => {
  const r = isWorkspaceAllowed(path.resolve('/anywhere/at/all'), ALLOW, DATA, false);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.path, path.resolve('/anywhere/at/all'));
});

test('rejects empty / non-string input regardless of enforcement', () => {
  assert.equal(isWorkspaceAllowed('', ALLOW, DATA, false).ok, false);
  assert.equal(isWorkspaceAllowed('   ', ALLOW, DATA, false).ok, false);
  assert.equal(isWorkspaceAllowed(undefined, ALLOW, DATA, false).ok, false);
  assert.equal(isWorkspaceAllowed(42, ALLOW, DATA, false).ok, false);
});

test('rejects a relative path even when enforcement is off', () => {
  const r = isWorkspaceAllowed('relative/dir', ALLOW, DATA, false);
  assert.equal(r.ok, false);
});

test('rejects UNC / device roots even when enforcement is off', () => {
  assert.equal(isWorkspaceAllowed('\\\\host\\share', ALLOW, DATA, false).ok, false);
  assert.equal(isWorkspaceAllowed('//host/share', ALLOW, DATA, false).ok, false);
});
