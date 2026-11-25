'use strict';

/*
 * Local typed repo tools. Everything runs in-process against the workspace;
 * no shell, no network. Read tools are cheap; apply_patch validates every
 * change before writing and keeps a local journal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const search = require('./repo-search');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function canonicalRoot(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

function insidePath(root, rel) {
  root = canonicalRoot(root);
  const abs = path.resolve(root, String(rel || ''));
  if (!isInside(root, abs)) return null;
  return abs;
}

function readText(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('file too large');
  return text;
}

function mapRepo(workspace, args = {}) {
  const files = search.walk(workspace, args.scope || ['.'], Number(args.depth) || 5)
    .slice(0, Math.max(1, Math.min(400, Number(args.limit) || 160)))
    .map((f) => f.rel);
  const configs = files.filter((f) => /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle|Makefile|Dockerfile|tsconfig\.json|\.github\/workflows\/)/i.test(f));
  const entrypoints = files.filter((f) => /(^|\/)(index|main|app|server|cli|agent|tui)\.(js|mjs|cjs|ts|tsx|py|go|rs)$/i.test(f));
  const symbols = [];
  for (const rel of files.slice(0, 120)) {
    const abs = path.join(workspace, rel);
    let text;
    try { text = readText(abs); } catch { continue; }
    for (const m of text.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|def|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      symbols.push({ name: m[1], path: rel });
      if (symbols.length >= 80) break;
    }
    if (symbols.length >= 80) break;
  }
  return { ok: true, data: { files, configs, entrypoints, symbols, truncated: files.length >= 160 } };
}

function symbolRepo(workspace, args = {}) {
  const name = String(args.name || '').trim();
  if (!name) return { ok: false, code: 'invalid_args', error: 'name is required' };
  const re = new RegExp('\\b(?:function|class|interface|type|enum|struct|trait|def|fn|const|let|var|export)\\b[^\\n]{0,80}\\b'
    + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  const hits = [];
  for (const file of search.walk(workspace, args.scope || ['.'], 12)) {
    let text;
    try { text = readText(file.abs); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      hits.push({
        path: file.rel,
        from: i + 1,
        to: i + 1,
        symbol: name,
        snippet: lines.slice(i, i + 4).join('\n'),
        reason: 'symbol definition',
      });
      if (hits.length >= Math.max(1, Math.min(20, Number(args.limit) || 8))) break;
    }
    if (hits.length >= 8) break;
  }
  return { ok: true, data: { name, hits } };
}

function referencesRepo(workspace, args = {}) {
  const name = String(args.symbol || args.name || '').trim();
  if (!name) return { ok: false, code: 'invalid_args', error: 'symbol is required' };
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  const hits = [];
  for (const file of search.walk(workspace, args.scope || ['.'], 12)) {
    let text;
    try { text = readText(file.abs); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      hits.push({
        path: file.rel,
        from: i + 1,
        to: i + 1,
        snippet: lines.slice(Math.max(0, i - 1), i + 2).join('\n'),
        reason: 'reference',
      });
      if (hits.length >= Math.max(1, Math.min(30, Number(args.limit) || 12))) break;
    }
    if (hits.length >= 12) break;
  }
  return { ok: true, data: { symbol: name, hits } };
}

function validateChanges(workspace, changes) {
  if (!Array.isArray(changes) || !changes.length) {
    return { ok: false, code: 'invalid_args', error: 'changes[] is required' };
  }
  if (changes.length > 20) return { ok: false, code: 'invalid_args', error: 'max 20 changes' };
  const prepared = [];
  for (const change of changes) {
    const rel = String(change.path || '').replace(/^\.\//, '');
    const abs = insidePath(workspace, rel);
    if (!abs) return { ok: false, code: 'out_of_scope', error: 'path outside workspace: ' + rel };
    if (/(^|\/)(\.git|\.harness|node_modules)(\/|$)/.test(toPosix(rel))) {
      return { ok: false, code: 'out_of_scope', error: 'refusing protected path: ' + rel };
    }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      return { ok: false, code: 'not_found', error: 'cannot read ' + rel + ': ' + e.message };
    }
    const digest = 'sha256:' + sha256(text);
    if (change.expectedDigest && String(change.expectedDigest) !== digest) {
      return { ok: false, code: 'stale_revision', error: 'digest mismatch for ' + rel, data: { path: rel, digest } };
    }
    let next;
    if (change.find != null) {
      const find = String(change.find);
      const replace = String(change.replace == null ? '' : change.replace);
      const count = text.split(find).length - 1;
      if (!count) return { ok: false, code: 'tool_error', error: 'find text not found in ' + rel };
      if (count > 1 && change.all !== true) {
        return { ok: false, code: 'tool_error', error: 'find text is ambiguous in ' + rel + ' (' + count + ' matches)' };
      }
      next = change.all === true ? text.split(find).join(replace) : text.replace(find, replace);
    } else {
      const lines = text.split('\n');
      const from = Math.max(1, Number(change.from) || 1);
      const to = Math.min(lines.length, Number(change.to) || from);
      if (to < from) return { ok: false, code: 'tool_error', error: 'invalid range for ' + rel };
      const replacement = String(change.text == null ? '' : change.text).split('\n');
      next = [...lines.slice(0, from - 1), ...replacement, ...lines.slice(to)].join('\n');
    }
    prepared.push({ rel, abs, before: text, after: next, digest, nextDigest: 'sha256:' + sha256(next) });
  }
  return { ok: true, prepared };
}

function applyPatch(workspace, args = {}, actionId) {
  workspace = canonicalRoot(workspace);
  const checked = validateChanges(workspace, args.changes);
  if (!checked.ok) return checked;
  const journalDir = path.join(workspace, '.harness', 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, 'patch-' + String(actionId || Date.now()) + '.json');
  const journal = {
    version: 1,
    actionId: actionId || null,
    at: new Date().toISOString(),
    workspace,
    changes: checked.prepared.map((p) => ({
      path: p.rel,
      beforeDigest: p.digest,
      afterDigest: p.nextDigest,
    })),
    status: 'prepared',
  };
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));

  const written = [];
  try {
    for (const item of checked.prepared) {
      const st = fs.statSync(item.abs);
      const tmp = item.abs + '.harness-tmp-' + process.pid;
      fs.writeFileSync(tmp, item.after, { mode: st.mode });
      fs.renameSync(tmp, item.abs);
      written.push({ path: item.rel, beforeDigest: item.digest, afterDigest: item.nextDigest });
    }
    journal.status = 'applied';
    journal.written = written;
    fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  } catch (e) {
    journal.status = 'partial';
    journal.error = e.message;
    journal.written = written;
    fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
    try { fs.rmSync(search.cachePath(workspace), { force: true }); } catch {}
    return {
      ok: false,
      code: 'tool_error',
      error: 'patch failed after ' + written.length + ' file(s): ' + e.message,
      data: { journal: toPosix(path.relative(workspace, journalFile)), written },
    };
  }
  try { fs.rmSync(search.cachePath(workspace), { force: true }); } catch {}
  return {
    ok: true,
    data: {
      journal: toPosix(path.relative(workspace, journalFile)),
      changes: written,
    },
  };
}

function runBatch(workspace, args = {}) {
  const actions = Array.isArray(args.actions) ? args.actions.slice(0, 3) : [];
  if (!actions.length) return { ok: false, code: 'invalid_args', error: 'actions[] is required (max 3)' };
  const allowed = new Set(['repo.search', 'repo.read', 'repo.list', 'repo.map', 'repo.symbol', 'repo.references']);
  const results = [];
  let bytes = 0;
  for (const action of actions) {
    const name = String(action && action.tool || '');
    if (!allowed.has(name)) {
      results.push({ tool: name, ok: false, code: 'policy_denied', error: 'not allowed in batch' });
      continue;
    }
    const result = runTool(workspace, name, action.args || {}, { batch: true });
    const size = Buffer.byteLength(JSON.stringify(result));
    if (bytes + size > 60000) {
      results.push({ tool: name, ok: false, code: 'output_limit', error: 'batch output limit reached' });
      break;
    }
    bytes += size;
    results.push({ tool: name, ...result });
  }
  return { ok: true, data: { results, bytes } };
}

function runTool(workspace, name, args = {}, opts = {}) {
  switch (name) {
    case 'repo.search': return search.search(workspace, args);
    case 'repo.read': return search.read(workspace, args);
    case 'repo.list': return search.list(workspace, args);
    case 'repo.map': return mapRepo(workspace, args);
    case 'repo.symbol': return symbolRepo(workspace, args);
    case 'repo.references': return referencesRepo(workspace, args);
    case 'repo.apply_patch':
      if (opts.readonly) return { ok: false, code: 'policy_denied', error: 'read-only mode' };
      return applyPatch(workspace, args, opts.actionId);
    case 'tool.batch': return runBatch(workspace, args);
    default:
      return { ok: false, code: 'invalid_args', error: 'unknown tool: ' + name };
  }
}

module.exports = {
  runTool,
  applyPatch,
  mapRepo,
  symbolRepo,
  referencesRepo,
};
