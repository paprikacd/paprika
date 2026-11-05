#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managedRoot = join(homedir(), '.paprika', 'plugin-marketplace');
const marker = join(managedRoot, '.paprika-plugin-installer');
const names = { observe: 'paprika-observe', fleet: 'paprika' };

function usage() {
  console.log('Paprika plugin installer (Codex / Claude Code)');
  console.log('Usage: paprika-plugins install <observe|fleet|all> --client <codex|claude|both> [--dry-run]');
  console.log('Example: paprika-plugins install observe --client codex');
  console.log('The plugin bundles an MCP endpoint; OAuth sign-in happens in your client.');
}

function fail(message) {
  console.error('Paprika plugin installer: ' + message);
  process.exitCode = 1;
}

function invoke(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false
  });
  if (result.error || result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(executable + ' ' + args.join(' ') + ' failed' + (detail ? ': ' + detail : ''));
  }
  return capture ? (result.stdout || '') : '';
}

function stageMarketplace() {
  const catalog = join(packageRoot, '.agents', 'plugins', 'marketplace.json');
  const claudeCatalog = join(packageRoot, '.claude-plugin', 'marketplace.json');
  for (const path of [catalog, join(packageRoot, 'plugins', 'paprika', 'plugin.json'), join(packageRoot, 'plugins', 'paprika-observe', 'mcp.json')]) {
    if (!existsSync(path)) throw new Error('npm package is missing ' + path);
  }
  const listing = JSON.parse(readFileSync(catalog, 'utf8'));
  for (const name of Object.values(names)) {
    if (!listing.plugins.some((entry) => entry.name === name)) {
      throw new Error('marketplace does not list ' + name);
    }
  }
  if (existsSync(managedRoot) && !existsSync(marker)) {
    throw new Error(managedRoot + ' exists but is not managed by this installer; refusing to overwrite it');
  }
  mkdirSync(dirname(managedRoot), { recursive: true });
  const staging = managedRoot + '.staging-' + process.pid;
  const backup = managedRoot + '.backup-' + process.pid;
  rmSync(staging, { force: true, recursive: true });
  try {
    mkdirSync(join(staging, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true });
    mkdirSync(join(staging, 'plugins'), { recursive: true });
    cpSync(catalog, join(staging, '.agents', 'plugins', 'marketplace.json'));
    cpSync(claudeCatalog, join(staging, '.claude-plugin', 'marketplace.json'));
    for (const plugin of Object.values(names)) {
      cpSync(join(packageRoot, 'plugins', plugin), join(staging, 'plugins', plugin), { recursive: true });
    }
    writeFileSync(join(staging, '.paprika-plugin-installer'), 'Managed by paprika-plugins; rerun npx to update.\n');
    if (existsSync(managedRoot)) renameSync(managedRoot, backup);
    try {
      renameSync(staging, managedRoot);
    } catch (error) {
      if (existsSync(backup) && !existsSync(managedRoot)) renameSync(backup, managedRoot);
      throw error;
    }
    rmSync(backup, { force: true, recursive: true });
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
  return managedRoot;
}

function installClient(client, plugins, marketplacePath, dryRun) {
  const tasks = [];
  const marketplace = [client, 'plugin', 'marketplace', 'add', marketplacePath];
  tasks.push(marketplace);
  for (const plugin of plugins) {
    tasks.push(client === 'codex'
      ? [client, 'plugin', 'add', plugin + '@paprika']
      : [client, 'plugin', 'install', plugin + '@paprika', '--scope', 'user']);
  }
  if (dryRun) {
    tasks.forEach((parts) => console.log('[dry-run] ' + parts.join(' ')));
    return;
  }
  invoke(client, ['--version'], true);
  const existingMarketplaces = invoke(client, ['plugin', 'marketplace', 'list'], true);
  if (!existingMarketplaces.includes('paprika')) {
    invoke(marketplace[0], marketplace.slice(1));
  } else {
    console.log(client + ': paprika marketplace is already registered; retained its existing registration.');
    if (!existingMarketplaces.includes(marketplacePath)) {
      console.log('Check that the registered paprika marketplace points to ' + marketplacePath + '.');
    }
  }
  const installed = invoke(client, ['plugin', 'list'], true);
  for (const plugin of plugins) {
    const id = plugin + '@paprika';
    if (installed.includes(id)) {
      console.log(client + ': ' + id + ' is already installed; refresh the plugin in your client to load updates.');
      continue;
    }
    if (client === 'codex') {
      invoke('codex', ['plugin', 'add', id]);
    } else {
      invoke('claude', ['plugin', 'install', id, '--scope', 'user']);
    }
  }
  console.log(client + ': package installed. Start a new session and complete native OAuth when prompted.');
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
  usage();
} else if (argv[0] !== 'install') {
  fail('expected install; run with --help for usage');
} else {
  const kind = argv[1];
  const dryRun = argv.includes('--dry-run');
  const at = argv.indexOf('--client');
  const client = at === -1 ? 'codex' : argv[at + 1];
  const validFlags = new Set(['--dry-run', '--client']);
  const extras = argv.slice(2).filter((x, i, xs) => {
    if (x === '--client') return false;
    if (i > 0 && xs[i - 1] === '--client') return false;
    return !validFlags.has(x);
  });
  if (!['observe', 'fleet', 'all'].includes(kind)) {
    fail('choose observe, fleet or all');
  } else if (!['codex', 'claude', 'both'].includes(client) || at === argv.length - 1 || extras.length) {
    fail('choose --client codex, claude or both (and no unsupported options)');
  } else {
    try {
      const plugins = kind === 'all' ? [names.fleet, names.observe] : [names[kind]];
      const targets = client === 'both' ? ['codex', 'claude'] : [client];
      const marketplacePath = dryRun ? managedRoot : stageMarketplace();
      for (const target of targets) installClient(target, plugins, marketplacePath, dryRun);
      if (!dryRun) {
        console.log('OAuth: approve paprika:observe for Observe reads; request paprika:insights:write separately for authoring.');
        console.log('Verify tool discovery with list_observability_providers (Observe) or fleet_status (fleet).');
        console.log('ChatGPT requires a separately registered custom MCP app; npx cannot grant OAuth or create that app.');
      }
    } catch (error) {
      fail(error.message);
    }
  }
}
