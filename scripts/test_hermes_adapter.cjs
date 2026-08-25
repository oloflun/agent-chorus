#!/usr/bin/env node
/**
 * Behaviour tests for the Hermes adapter.
 *
 * Plain Node, no Rust: the .sh suites shell out to the compiled binary, and a
 * host that only relays for Hermes has no toolchain to build it. This runs
 * anywhere `chorus` itself runs.
 *
 * Fixtures are written to a temp dir rather than fixtures/session-store/,
 * because the adapter locates sessions through CHORUS_HERMES_DATA_DIR and the
 * test needs to own that path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(os.tmpdir(), 'chorus-hermes-test', 'sessions');
fs.rmSync(path.dirname(dir), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const vault = path.join('C:', 'Users', 'sebbe', 'vault');
const otherProject = path.join('C:', 'Users', 'sebbe', 'Desktop', 'snipe-leads');

// The malformed line sits in the MIDDLE deliberately. readJsonlLines drops an
// incomplete LAST line to stay safe against reading a file another process is
// still writing, so a broken final line never reaches the adapter at all.
const rows = [
  { cwd: vault, role: 'user', content: 'Vad är status på infran?' },
  { role: 'assistant', content: 'Kollade STATUS.md — allt grönt utom QMD-indexet.' },
  'inte-json-alls',
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reindexerade QMD. Klart.' }] } },
];
fs.writeFileSync(
  path.join(dir, 'sess-vault.jsonl'),
  rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
);

// A second session in another project, to exercise cwd scoping.
fs.writeFileSync(
  path.join(dir, 'sess-annat.jsonl'),
  JSON.stringify({ cwd: otherProject, role: 'assistant', content: 'Hemlig text från ett annat projekt.' }) + '\n'
);

process.env.CHORUS_HERMES_DATA_DIR = dir;
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

console.log('=== Hermes adapter tests ===');

// list
check('list-all', hermes.list(null, 10).map(e => e.session_id).sort(), ['sess-annat', 'sess-vault']);
const scoped = hermes.list(vault, 10);
check('list-scoped-to-cwd', scoped.map(e => e.session_id), ['sess-vault']);
check('list-reads-cwd', scoped[0] && scoped[0].cwd, vault);

// resolve
const resolved = hermes.resolve(null, vault, {});
check('resolve-no-warnings-on-match', resolved && resolved.warnings, []);
check('resolve-picks-matching-session', resolved && path.basename(resolved.path), 'sess-vault.jsonl');

// read — both assistant shapes, and the malformed line is reported not hidden
const session = hermes.read(resolved.path, 2);
check('read-agent', session.agent, 'hermes');
check('read-cwd', session.cwd, vault);
check('read-message-count', session.message_count, 2);
check('read-messages-returned', session.messages_returned, 2);
check(
  'read-content-both-schemas',
  session.content,
  'Kollade STATUS.md — allt grönt utom QMD-indexet.\n---\nReindexerade QMD. Klart.'
);
check('read-warns-about-malformed-line', session.warnings.length, 1);
check('read-latest-only', hermes.read(resolved.path, 1).content, 'Reindexerade QMD. Klart.');

// search — assistant text only, and never across the cwd boundary
check('search-hit', hermes.search('QMD', vault, 10).map(e => e.session_id), ['sess-vault']);
check('search-ignores-user-text', hermes.search('status på infran', vault, 10).length, 0);
check('search-respects-cwd-scope', hermes.search('Hemlig', vault, 10).length, 0);

// absent install: every entry point stays quiet instead of throwing
process.env.CHORUS_HERMES_DATA_DIR = path.join(os.tmpdir(), 'chorus-hermes-test', 'finns-inte');
delete require.cache[require.resolve('./adapters/hermes.cjs')];
const absent = require('./adapters/hermes.cjs');
check('absent-resolve', absent.resolve(null, vault, {}), null);
check('absent-list', absent.list(vault, 10), []);
check('absent-search', absent.search('x', vault, 10), []);

console.log(`\n=== Results: ${failed === 0 ? 'all green' : `${failed} failed`} ===`);
process.exit(failed === 0 ? 0 : 1);
