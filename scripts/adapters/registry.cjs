/**
 * Adapter registry — returns the adapter for a given agent name.
 * Each adapter exports: { resolve(id, cwd, opts), read(filePath, lastN), list(cwd, limit) }
 */

const codex = require('./codex.cjs');
const gemini = require('./gemini.cjs');
const claude = require('./claude.cjs');
const cursor = require('./cursor.cjs');
const hermes = require('./hermes.cjs');

const adapters = {
  codex,
  gemini,
  claude,
  cursor,
  hermes,
};

function getAdapter(agent) {
  const adapter = adapters[agent];
  if (!adapter) {
    // Names the valid agents, like the CLI's own guard does. The wording still
    // starts with "Unsupported agent" so the UNSUPPORTED_AGENT error code is
    // derived from it unchanged.
    throw new Error(`Unsupported agent: ${agent}. Valid: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
}

function listAdapters() {
  return Object.keys(adapters);
}

module.exports = { getAdapter, listAdapters, adapters };
