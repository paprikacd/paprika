import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(root, 'bin/paprika-plugins.mjs');
const call = (args) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8' });

test('help documents the plugin installer and OAuth boundary', () => {
  const result = call(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OAuth sign-in happens in your client/);
});

test('dry-run plans Codex Observe marketplace installation', () => {
  const result = call(['install', 'observe', '--client', 'codex', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex plugin marketplace add/);
  assert.match(result.stdout, /codex plugin add paprika-observe@paprika/);
  assert.doesNotMatch(result.stdout, /paprika@paprika$/m);
});

test('dry-run supports Claude fleet and both clients', () => {
  const result = call(['install', 'all', '--client', 'both', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude plugin install paprika-observe@paprika --scope user/);
  assert.match(result.stdout, /codex plugin add paprika@paprika/);
});

test('unknown clients and options fail without changing user configuration', () => {
  for (const args of [['install', 'observe', '--client', 'nope', '--dry-run'], ['install', 'observe', '--unexpected'], ['install', 'bad']]) {
    const result = call(args);
    assert.notEqual(result.status, 0, args.join(' '));
  }
});

test('npm package includes marketplace, OAuth configuration and skills', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const paths = new Set(JSON.parse(pack.stdout)[0].files.map((entry) => entry.path));
  for (const file of [
    'bin/paprika-plugins.mjs',
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'plugins/paprika/plugin.json',
    'plugins/paprika-observe/plugin.json',
    'plugins/paprika-observe/mcp.json',
    'plugins/paprika-observe/.mcp.json',
    'plugins/paprika-observe/skills/paprika-observe/SKILL.md'
  ]) {
    assert.ok(paths.has(file), 'npx package missing ' + file);
  }
});
