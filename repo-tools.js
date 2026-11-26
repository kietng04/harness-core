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

const IMPORT_RE = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(workspace, fromRel, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(workspace, fromRel)), spec);
  const candidates = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.ts',
    base + '.tsx', base + '.jsx', base + '.py', base + '.go', base + '.rs',
    path.join(base, 'index.js'), path.join(base, 'index.ts')];
  for (const c of candidates) {
    if (fileSet.has(toPosix(path.relative(workspace, c)))) return toPosix(path.relative(workspace, c));
  }
  return null;
}

function graphRepo(workspace, args = {}) {
  const files = search.walk(workspace, args.scope || ['.'], Number(args.depth) || 8);
  const fileSet = new Set(files.map((f) => f.rel));
  const nodes = files.map((f) => ({ path: f.rel, kind: path.extname(f.rel).slice(1) || 'file' }));
  const edges = [];
  const unresolved = [];
  let bytes = 0;
  for (const file of files) {
    let text;
    try { text = readText(file.abs); } catch { continue; }
    bytes += text.length;
    if (bytes > 8 * 1024 * 1024) break;
    IMPORT_RE.lastIndex = 0;
    for (const m of text.matchAll(IMPORT_RE)) {
      const to = resolveImport(workspace, file.rel, m[1], fileSet);
      if (to) edges.push({ from: file.rel, to, kind: 'import' });
      else unresolved.push({ from: file.rel, spec: m[1] });
      if (edges.length >= 5000) break;
    }
    if (edges.length >= 5000) break;
  }
  return {
    ok: true,
    data: {
      nodes: nodes.slice(0, 1000),
      edges: edges.slice(0, 5000),
      unresolved: unresolved.slice(0, 200),
      truncated: nodes.length > 1000 || edges.length >= 5000,
    },
  };
}

function impactRepo(workspace, args = {}) {
  const changed = Array.isArray(args.paths) ? args.paths.map(String) : [String(args.path || '')].filter(Boolean);
  if (!changed.length) return { ok: false, code: 'invalid_args', error: 'path or paths[] is required' };
  const graph = graphRepo(workspace, { depth: 12 });
  if (!graph.ok) return graph;
  const reverse = new Map();
  for (const edge of graph.data.edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    reverse.get(edge.to).push(edge.from);
  }
  const affected = new Set();
  const queue = changed.map((p) => ({ path: p.replace(/^\.\//, ''), depth: 0 }));
  while (queue.length) {
    const cur = queue.shift();
    if (cur.depth > 2) continue;
    for (const from of reverse.get(cur.path) || []) {
      if (affected.has(from)) continue;
      affected.add(from);
      queue.push({ path: from, depth: cur.depth + 1 });
    }
  }
  return {
    ok: true,
    data: {
      changed,
      affected: [...affected].slice(0, 100),
      edges: graph.data.edges.filter((e) => changed.includes(e.from) || affected.has(e.from)).slice(0, 200),
      advisory: true,
    },
  };
}

function testsRepo(workspace, args = {}) {
  const changed = Array.isArray(args.paths) ? args.paths.map(String) : [String(args.path || '')].filter(Boolean);
  if (!changed.length) return { ok: false, code: 'invalid_args', error: 'path or paths[] is required' };
  const tokens = new Set();
  for (const rel of changed) {
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    for (const t of base.split(/[^A-Za-z0-9]+/)) if (t.length > 2) tokens.add(t.toLowerCase());
    for (const part of base.split(/(?=[A-Z])/)) if (part.length > 2) tokens.add(part.toLowerCase());
  }
  const suggestions = [];
  for (const file of search.walk(workspace, args.scope || ['.'], 12)) {
    if (!/(^|\/)(__tests__|test|tests|spec)(\/|\.)|\.(test|spec)\./i.test(file.rel)) continue;
    const lower = file.rel.toLowerCase();
    const score = [...tokens].filter((t) => lower.includes(t)).length;
    if (score) suggestions.push({ path: file.rel, score, reason: 'name overlap: ' + [...tokens].filter((t) => lower.includes(t)).join(', ') });
  }
  suggestions.sort((a, b) => b.score - a.score);
  return { ok: true, data: { changed, suggestions: suggestions.slice(0, 10), advisory: true } };
}

function backendUnavailable(tool) {
  return {
    ok: false,
    code: 'policy_unavailable',
    error: tool + ' needs HARNESS_EXECUTION_BACKEND with an approved execution backend',
  };
}

function diagnosticsRepo(workspace, args = {}) {
  if (!process.env.HARNESS_EXECUTION_BACKEND) return backendUnavailable('workspace.diagnostics');
  return { ok: false, code: 'policy_unavailable', error: 'diagnostics adapter is not configured for this backend' };
}

function testRepo(workspace, args = {}) {
  if (!process.env.HARNESS_EXECUTION_BACKEND) return backendUnavailable('workspace.test');
  return { ok: false, code: 'policy_unavailable', error: 'test recipe runner is not configured for this backend' };
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
      beforeText: p.before,
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

function rollback(workspace, args = {}, actionId) {
  workspace = canonicalRoot(workspace);
  const rel = String(args.journal || '');
  const journalAbs = insidePath(workspace, rel);
  if (!journalAbs || !/\.harness[\/\\]journal[\/\\]/.test(toPosix(journalAbs))) {
    return { ok: false, code: 'out_of_scope', error: 'journal must live under .harness/journal' };
  }
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalAbs, 'utf8')); } catch (e) {
    return { ok: false, code: 'not_found', error: 'cannot read journal: ' + e.message };
  }
  if (!journal || !Array.isArray(journal.changes) || !journal.changes.length) {
    return { ok: false, code: 'invalid_args', error: 'journal has no changes' };
  }
  if (!['applied', 'partial'].includes(journal.status)) {
    return { ok: false, code: 'policy_denied', error: 'only applied/partial journals can roll back' };
  }
  const prepared = [];
  for (const change of journal.changes) {
    const abs = insidePath(workspace, change.path);
    if (!abs) return { ok: false, code: 'out_of_scope', error: 'path outside workspace: ' + change.path };
    let current;
    try { current = fs.readFileSync(abs, 'utf8'); } catch (e) {
      return { ok: false, code: 'not_found', error: 'cannot read ' + change.path + ': ' + e.message };
    }
    const digest = 'sha256:' + sha256(current);
    if (digest !== change.afterDigest) {
      return { ok: false, code: 'stale_revision', error: 'current file changed since patch: ' + change.path, data: { digest } };
    }
    if (typeof change.beforeText !== 'string') {
      return { ok: false, code: 'tool_error', error: 'journal has no beforeText for ' + change.path };
    }
    prepared.push({ abs, rel: change.path, beforeText: change.beforeText });
  }
  for (const item of prepared) {
    const tmp = item.abs + '.harness-rollback-' + process.pid;
    const st = fs.statSync(item.abs);
    fs.writeFileSync(tmp, item.beforeText, { mode: st.mode });
    fs.renameSync(tmp, item.abs);
  }
  const out = {
    version: 1,
    actionId: actionId || null,
    at: new Date().toISOString(),
    workspace,
    rollbackOf: journalAbs,
    status: 'applied',
    files: prepared.map((p) => p.rel),
  };
  const outFile = path.join(workspace, '.harness', 'journal', 'rollback-' + String(actionId || Date.now()) + '.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  try { fs.rmSync(search.cachePath(workspace), { force: true }); } catch {}
  return { ok: true, data: { journal: toPosix(path.relative(workspace, outFile)), files: out.files } };
}

function runBatch(workspace, args = {}) {
  const actions = Array.isArray(args.actions) ? args.actions.slice(0, 3) : [];
  if (!actions.length) return { ok: false, code: 'invalid_args', error: 'actions[] is required (max 3)' };
  const allowed = new Set(['repo.search', 'repo.read', 'repo.list', 'repo.map', 'repo.symbol', 'repo.references', 'repo.graph', 'repo.impact', 'repo.tests']);
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
    case 'repo.graph': return graphRepo(workspace, args);
    case 'repo.impact': return impactRepo(workspace, args);
    case 'repo.tests': return testsRepo(workspace, args);
    case 'workspace.diagnostics': return diagnosticsRepo(workspace, args);
    case 'workspace.test': return testRepo(workspace, args);
    case 'repo.apply_patch':
      if (opts.readonly) return { ok: false, code: 'policy_denied', error: 'read-only mode' };
      return applyPatch(workspace, args, opts.actionId);
    case 'repo.rollback':
      if (opts.readonly) return { ok: false, code: 'policy_denied', error: 'read-only mode' };
      return rollback(workspace, args, opts.actionId);
    case 'tool.batch': return runBatch(workspace, args);
    default:
      return { ok: false, code: 'invalid_args', error: 'unknown tool: ' + name };
  }
}

module.exports = {
  runTool,
  applyPatch,
  rollback,
  mapRepo,
  symbolRepo,
  referencesRepo,
  graphRepo,
  impactRepo,
  testsRepo,
};
