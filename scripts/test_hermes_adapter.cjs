#!/usr/bin/env node
/**
 * Behaviour tests for the Hermes adapter and the derived agent list.
 *
 * Plain Node, no Rust: the .sh suites shell out to the compiled binary, and a
 * host that only relays for Hermes has no toolchain to build it. This runs
 * anywhere `chorus` itself runs.
 *
 * Two things are covered, and they are two halves of one bug. The adapter has
 * to exist for `send`/`messages` to accept the name, and the agent list has to
 * be derived for every other command to accept it too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, 'read_session.cjs');

const root = path.join(os.tmpdir(), 'chorus-hermes-test');
fs.rmSync(root, { recursive: true, force: true });

// Hermes's own session store, and a project-local session-logs/ mirror — the
// two places the adapter looks.
const hermesStore = path.join(root, 'hermes-sessions');
const projectA = path.join(root, 'project-a');
const projectB = path.join(root, 'project-b');
fs.mkdirSync(hermesStore, { recursive: true });
fs.mkdirSync(path.join(projectA, 'session-logs'), { recursive: true });
fs.mkdirSync(path.join(projectB, 'session-logs'), { recursive: true });

fs.writeFileSync(
  path.join(hermesStore, '2026-08-25-infra.md'),
  '# Hermes session\n\nReindexerade QMD. Allt grönt.\n'
);
fs.writeFileSync(
  path.join(projectA, 'session-logs', '2026-08-25-session-log.md'),
  '# Session Log\n\nProjekt A: lagade uppladdningen.\n'
);
fs.writeFileSync(
  path.join(projectB, 'session-logs', '2026-08-24-session-log.md'),
  '# Session Log\n\nProjekt B: hemlig text som inte hör hemma i A.\n'
);

process.env.CHORUS_HERMES_SESSIONS_DIR = hermesStore;
const hermes = require('./adapters/hermes.cjs');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}`
    + (ok ? '' : `\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  );
}

function cli(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHORUS_SKIP_UPDATE_CHECK: '1' },
  });
}

console.log('=== Hermes adapter ===');

// The project-local mirror is found, and its cwd is read off the path. This is
// the assertion that fails on Windows without the separator fix in
// getHermesSessionCwd: path.resolve yields backslashes, the '/session-logs/'
// marker never matches, and every entry reports cwd null.
const inA = hermes.list(projectA, 10);
check('list-finds-project-mirror', inA.some(e => e.session_id === '2026-08-25-session-log'), true);
check(
  'list-reads-cwd-from-path',
  (inA.find(e => e.session_id === '2026-08-25-session-log') || {}).cwd,
  projectA
);

// Scoping: project B's log must not surface under project A. With cwd null the
// filter is skipped entirely, so this is where the leak would show.
check('list-excludes-other-project', inA.some(e => e.session_id === '2026-08-24-session-log'), false);
check('search-respects-cwd-scope', hermes.search('hemlig', projectA, 10).length, 0);
check('search-hit-in-scope', hermes.search('Projekt A', projectA, 10).length, 1);

// Hermes's own store carries no project, so it stays cwd-less and always visible.
const store = hermes.list(null, 10).find(e => e.session_id === '2026-08-25-infra');
check('hermes-store-entry-present', Boolean(store), true);
check('hermes-store-has-no-cwd', store && store.cwd, null);

// read
const resolved = hermes.resolve(null, projectA, {});
check('resolve-picks-scoped-log', resolved && path.basename(resolved.path), '2026-08-25-session-log.md');
const session = hermes.read(resolved.path, 1);
check('read-agent', session.agent, 'hermes');
check('read-cwd', session.cwd, projectA);
check('read-content', session.content.includes('Projekt A: lagade uppladdningen.'), true);

// absent install: quiet, not a crash
process.env.CHORUS_HERMES_SESSIONS_DIR = path.join(root, 'finns-inte');
delete require.cache[require.resolve('./adapters/hermes.cjs')];
const absent = require('./adapters/hermes.cjs');
check('absent-store-resolve', absent.resolve(null, path.join(root, 'tomt'), {}), null);
check('absent-store-list', absent.list(path.join(root, 'tomt'), 10), []);

console.log('\n=== Derived agent list ===');

// Every command must accept hermes, not just send/messages. Before the list was
// derived these five rejected or silently skipped it.
check('help-lists-hermes', cli(['read', '--help']).includes('|hermes>'), true);
check('search-error-lists-hermes', (() => {
  try { cli(['search', 'x']); return false; } catch (e) {
    return String(e.stderr || e.stdout || '').includes('|hermes>');
  }
})(), true);
check('diff-error-lists-hermes', (() => {
  try { cli(['diff']); return false; } catch (e) {
    return String(e.stderr || e.stdout || '').includes('|hermes>');
  }
})(), true);
check('doctor-checks-hermes', cli(['doctor', '--json']).includes('sessions_hermes'), true);
check('list-accepts-hermes', (() => {
  const out = cli(['list', '--agent', 'hermes', '--cwd', projectA, '--json']);
  return JSON.parse(out).every(e => e.agent === 'hermes');
})(), true);

// And an unknown agent must still be refused, with the valid names named.
check('unknown-agent-still-refused', (() => {
  try { cli(['list', '--agent', 'rymdfarja', '--json']); return false; } catch (e) {
    const text = String(e.stderr || e.stdout || '');
    return text.includes('rymdfarja') && text.includes('hermes');
  }
})(), true);

console.log(`\n=== Results: ${failed === 0 ? 'all green' : `${failed} failed`} ===`);
process.exit(failed === 0 ? 0 : 1);
