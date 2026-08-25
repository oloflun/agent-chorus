/**
 * Hermes agent adapter.
 *
 * Hermes is a WSL-hosted agent in the super-intelligence stack. Unlike the
 * other four agents it has no vendor-defined session store, so the location is
 * a convention this adapter owns: `~/.hermes/sessions/*.jsonl`, overridable
 * with CHORUS_HERMES_DATA_DIR.
 *
 * On a host where Hermes is not installed the directory simply does not exist,
 * and every function here returns empty — the same shape `cursor.cjs` uses when
 * Cursor is absent. That matters for the reason this adapter was added at all:
 * `send` and `messages` validate against the adapter registry, so without an
 * entry here `chorus send --to hermes` fails with UNSUPPORTED_AGENT even though
 * the mailbox `.agent-chorus/messages/hermes.jsonl` and the provider contract
 * `.agent-chorus/providers/hermes.md` both exist. Coordination must work on a
 * host that only relays for Hermes; session reading is the part that needs
 * Hermes to actually be there.
 *
 * The line schema is read tolerantly (`{role, content}` and the Claude-style
 * `{type:'assistant', message:{content}}` both parse) because Hermes was not
 * installed on the machine this adapter was written on. Anything it cannot
 * parse is skipped and counted, never guessed at.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizePath, collectMatchingFiles, readJsonlLines,
  findLatestByCwd, cwdMatchesProject, getFileTimestamp, extractClaudeText,
  redactSensitiveText, isSystemDirectory,
} = require('./utils.cjs');

const hermesSessionsBase = normalizePath(
  process.env.CHORUS_HERMES_DATA_DIR || process.env.BRIDGE_HERMES_DATA_DIR || '~/.hermes/sessions'
);

if (isSystemDirectory(hermesSessionsBase)) {
  throw new Error(`Refusing to scan system directory: ${hermesSessionsBase}`);
}

function isHermesFile(name) {
  return name.endsWith('.jsonl');
}

/** The cwd a session ran in, from the first line that declares one. */
function getHermesSessionCwd(filePath) {
  try {
    for (const line of readJsonlLines(filePath)) {
      try {
        const json = JSON.parse(line);
        const cwd = json.cwd || (json.meta && json.meta.cwd);
        if (typeof cwd === 'string') return normalizePath(cwd);
      } catch (error) { /* skip malformed */ }
    }
  } catch (error) {
    return null;
  }
  return null;
}

/** Assistant text out of one JSONL line, or '' when the line is something else. */
function assistantTextFromLine(line) {
  let json;
  try {
    json = JSON.parse(line);
  } catch (error) {
    return null; // signals "unparseable" to the caller
  }

  const message = json.message || json;
  const role = String(json.type || message.role || '').toLowerCase();
  if (role !== 'assistant') return '';

  const content = message.content !== undefined ? message.content : json.content;
  if (typeof content === 'string') return content;
  return extractClaudeText(content) || '';
}

function resolve(id, cwd, opts) {
  const warnings = [];
  if (!fs.existsSync(hermesSessionsBase)) return null;

  if (id) {
    const files = collectMatchingFiles(
      hermesSessionsBase,
      (fullPath, name) => isHermesFile(name) && fullPath.includes(id),
      true
    );
    return files.length > 0 ? { path: files[0].path, warnings } : null;
  }

  const files = collectMatchingFiles(hermesSessionsBase, (_fp, name) => isHermesFile(name), true);
  if (files.length === 0) return null;

  const scoped = findLatestByCwd(files, getHermesSessionCwd, cwd);
  if (scoped) return { path: scoped, warnings };

  warnings.push(`Warning: no Hermes session matched cwd ${cwd}; falling back to latest session.`);
  return { path: files[0].path, warnings };
}

function read(filePath, lastN) {
  lastN = lastN || 1;
  const lines = readJsonlLines(filePath);
  const messages = [];
  let skipped = 0;
  let sessionCwd = null;

  for (const line of lines) {
    const text = assistantTextFromLine(line);
    if (text === null) {
      skipped += 1;
      continue;
    }
    if (!sessionCwd) {
      try {
        const json = JSON.parse(line);
        const cwd = json.cwd || (json.meta && json.meta.cwd);
        if (typeof cwd === 'string') sessionCwd = cwd;
      } catch (error) { /* already counted above */ }
    }
    if (text) messages.push(text);
  }

  const warnings = [];
  if (skipped > 0) {
    warnings.push(`Warning: skipped ${skipped} unparseable line(s) in ${filePath}`);
  }

  const sessionId = path.basename(filePath, path.extname(filePath));
  let content;
  let messagesReturned = 1;

  if (messages.length > 0) {
    if (lastN > 1) {
      const selected = messages.slice(-lastN);
      messagesReturned = selected.length;
      content = selected.join('\n---\n');
    } else {
      content = messages[messages.length - 1];
    }
  } else {
    content = `Could not extract assistant messages. Showing last 20 raw lines:\n${lines.slice(-20).join('\n')}`;
    messagesReturned = 0;
  }

  return {
    agent: 'hermes',
    source: filePath,
    content: redactSensitiveText(content),
    warnings,
    session_id: sessionId,
    cwd: sessionCwd,
    timestamp: getFileTimestamp(filePath),
    message_count: messages.length,
    messages_returned: messagesReturned,
  };
}

function list(cwd, limit) {
  limit = limit || 10;
  if (!fs.existsSync(hermesSessionsBase)) return [];

  const files = collectMatchingFiles(hermesSessionsBase, (_fp, name) => isHermesFile(name), true);
  const expectedCwd = cwd ? normalizePath(cwd) : null;
  const entries = [];

  for (const f of files) {
    const fileCwd = getHermesSessionCwd(f.path) || null;
    if (expectedCwd && !cwdMatchesProject(fileCwd, expectedCwd)) continue;

    entries.push({
      session_id: path.basename(f.path, path.extname(f.path)),
      agent: 'hermes',
      cwd: fileCwd,
      modified_at: getFileTimestamp(f.path),
      file_path: f.path,
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

function search(query, cwd, limit) {
  limit = limit || 10;
  const queryLower = String(query || '').toLowerCase();
  const expectedCwd = cwd ? normalizePath(cwd) : null;
  if (!fs.existsSync(hermesSessionsBase)) return [];

  const files = collectMatchingFiles(hermesSessionsBase, (_fp, name) => isHermesFile(name), true);
  const entries = [];

  for (const f of files) {
    if (entries.length >= limit) break;

    const fileCwd = getHermesSessionCwd(f.path) || null;
    if (expectedCwd && !cwdMatchesProject(fileCwd, expectedCwd)) continue;

    // Only assistant text is searched, never the raw file: a hit inside a user
    // prompt or a tool payload is not something Hermes said.
    let assistantText = '';
    try {
      for (const line of readJsonlLines(f.path)) {
        const text = assistantTextFromLine(line);
        if (text) assistantText += text + '\n';
      }
    } catch (error) {
      continue;
    }

    const lowerText = assistantText.toLowerCase();
    if (!lowerText.includes(queryLower)) continue;

    const idx = lowerText.indexOf(queryLower);
    const snippetStart = Math.max(0, idx - 60);
    const snippetEnd = Math.min(assistantText.length, idx + queryLower.length + 60);
    const match_snippet = assistantText.slice(snippetStart, snippetEnd).replace(/\n/g, ' ');

    entries.push({
      session_id: path.basename(f.path, path.extname(f.path)),
      agent: 'hermes',
      cwd: fileCwd,
      modified_at: getFileTimestamp(f.path),
      file_path: f.path,
      match_snippet,
    });
  }

  return entries;
}

module.exports = { resolve, read, list, search };
