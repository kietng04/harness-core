'use strict';

/*
 * Local typed repo tools. Everything runs in-process against the workspace;
 * no shell, no network. Read tools are cheap; apply_patch validates every
 * change before writing and keeps a local journal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const search = require('./repo-search');
const ignore = require('./ignore');
const hierarchy = require('./call-hierarchy');

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

function nearestExistingDir(root, abs) {
  let cur = path.dirname(abs);
  while (true) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur || !isInside(root, parent)) return root;
    cur = parent;
  }
}

function validateChanges(workspace, changes, opts = {}) {
  if (!Array.isArray(changes) || !changes.length) {
    return { ok: false, code: 'invalid_args', error: 'changes[] is required' };
  }
  if (changes.length > 20) return { ok: false, code: 'invalid_args', error: 'max 20 changes' };
  const matcher = ignore.createIgnoreMatcher(workspace);
  const planMode = opts.mode === 'plan' || opts.planMode === true;
  const knownDigests = opts.knownDigests || null;

  // Group by file first. Multiple edits in one request share one base image
  // and produce one before/after journal pair, as the plan requires.
  const groups = new Map();
  for (const change of changes) {
    const rel = String(change.path || '').replace(/^\.\//, '');
    if (!groups.has(rel)) groups.set(rel, []);
    groups.get(rel).push(change);
  }

  const prepared = [];
  for (const [rel, fileChanges] of groups) {
    const abs = insidePath(workspace, rel);
    if (!abs) return { ok: false, code: 'out_of_scope', error: 'path outside workspace: ' + rel };
    if (ignore.isProtectedPath(rel, { planMode }) || matcher.isCursorIgnored(rel)) {
      return { ok: false, code: 'out_of_scope', error: 'refusing protected path: ' + rel };
    }
    if (planMode && !ignore.isPlanWritablePath(rel)) {
      return { ok: false, code: 'policy_denied', error: 'plan mode forbids editing ' + rel + ' (only plan markdown files)' };
    }
    const exists = fs.existsSync(abs);
    if (exists) {
      let real;
      try { real = fs.realpathSync(abs); } catch { real = abs; }
      if (!isInside(workspace, real)) {
        return { ok: false, code: 'out_of_scope', error: 'symlink escapes workspace: ' + rel };
      }
      const realRel = toPosix(path.relative(workspace, real));
      if (ignore.isProtectedPath(realRel, { planMode }) || matcher.isCursorIgnored(realRel)) {
        return { ok: false, code: 'out_of_scope', error: 'refusing protected symlink target: ' + realRel };
      }
    } else {
      let realParent;
      try { realParent = fs.realpathSync(nearestExistingDir(workspace, abs)); } catch { realParent = workspace; }
      if (!isInside(workspace, realParent)) {
        return { ok: false, code: 'out_of_scope', error: 'parent symlink escapes workspace: ' + rel };
      }
    }

    const create = !exists && fileChanges.some((c) => c.create === true || (planMode && ignore.isPlanWritablePath(rel) && c.find == null));
    if (create) {
      if (fileChanges.length > 1) {
        return { ok: false, code: 'invalid_args', error: 'create supports one change per file: ' + rel };
      }
      const change = fileChanges[0];
      const next = String(change.text == null ? (change.replace == null ? '' : change.replace) : change.text);
      prepared.push({
        rel, abs, created: true, before: null, after: next,
        digest: 'sha256:new', nextDigest: 'sha256:' + sha256(next),
      });
      continue;
    }

    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      return { ok: false, code: 'not_found', error: 'cannot read ' + rel + ': ' + e.message };
    }
    const digest = 'sha256:' + sha256(text);
    for (const change of fileChanges) {
      const expected = change.expectedDigest || (knownDigests && knownDigests[rel]);
      if (expected && String(expected) !== digest) {
        return {
          ok: false, code: 'stale_revision',
          error: 'file changed externally since last read for ' + rel + '; re-read with repo.read before patching',
          data: { path: rel, digest, expectedDigest: String(expected) },
        };
      }
    }

    const rangeChanges = [];
    const findChanges = [];
    const baseLines = text.split('\n');
    for (const change of fileChanges) {
      if (change.find != null) {
        findChanges.push(change);
      } else {
        const from = Math.max(1, Number(change.from) || 1);
        const to = Math.min(baseLines.length, Number(change.to) || from);
        if (to < from) return { ok: false, code: 'tool_error', error: 'invalid range for ' + rel };
        rangeChanges.push({ from, to, text: String(change.text == null ? '' : change.text) });
      }
    }

    rangeChanges.sort((a, b) => b.from - a.from);
    for (let i = 1; i < rangeChanges.length; i++) {
      if (rangeChanges[i].to >= rangeChanges[i - 1].from) {
        return { ok: false, code: 'tool_error', error: 'overlapping range edits in ' + rel };
      }
    }
    let current = text;
    for (const range of rangeChanges) {
      const lines = current.split('\n');
      const replacement = range.text.split('\n');
      current = [...lines.slice(0, range.from - 1), ...replacement, ...lines.slice(range.to)].join('\n');
    }

    for (const change of findChanges) {
      const find = String(change.find);
      const replace = String(change.replace == null ? '' : change.replace);
      const count = current.split(find).length - 1;
      if (!count) return { ok: false, code: 'tool_error', error: 'find text not found in ' + rel };
      if (count > 1 && change.all !== true) {
        return { ok: false, code: 'tool_error', error: 'find text is ambiguous in ' + rel + ' (' + count + ' matches)' };
      }
      if (change.all === true) current = current.split(find).join(replace);
      else current = current.replace(find, () => replace);
    }

    prepared.push({
      rel, abs, created: false, before: text, after: current,
      digest, nextDigest: 'sha256:' + sha256(current),
    });
  }
  return { ok: true, prepared };
}

function applyPatch(workspace, args = {}, actionId, opts = {}) {
  workspace = canonicalRoot(workspace);
  const checked = validateChanges(workspace, args.changes, opts);
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
      created: !!p.created,
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
      let fileMode = 0o644;
      if (!item.created) {
        fileMode = fs.statSync(item.abs).mode;
      } else {
        fs.mkdirSync(path.dirname(item.abs), { recursive: true });
      }
      const tmp = item.abs + '.harness-tmp-' + process.pid;
      fs.writeFileSync(tmp, item.after, { mode: fileMode });
      fs.renameSync(tmp, item.abs);
      written.push({ path: item.rel, created: !!item.created, beforeDigest: item.digest, afterDigest: item.nextDigest });
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
    if (!change.created && typeof change.beforeText !== 'string') {
      return { ok: false, code: 'tool_error', error: 'journal has no beforeText for ' + change.path };
    }
    prepared.push({ abs, rel: change.path, created: !!change.created, beforeText: change.beforeText });
  }
  for (const item of prepared) {
    if (item.created) {
      fs.rmSync(item.abs, { force: true });
      continue;
    }
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

const SCHEMA_HINTS = {
  'repo.search': '{"query": string, "scope"?: string[], "match"?: "auto"|"literal"|"regex"|"hybrid", "limit"?: number}',
  'repo.read': '{"path": string, "from"?: number, "to"?: number, "expectedDigest"?: string}',
  'repo.list': '{"scope"?: string[], "depth"?: number, "limit"?: number}',
  'repo.map': '{"scope"?: string[], "limit"?: number}',
  'repo.symbol': '{"name": string, "scope"?: string[]}',
  'repo.references': '{"name": string, "scope"?: string[]}',
  'repo.graph': '{"scope"?: string[], "path"?: string}',
  'repo.impact': '{"path"?: string, "paths"?: string[], "scope"?: string[], "depth"?: number}',
  'repo.tests': '{"path"?: string, "paths"?: string[], "scope"?: string[]}',
  'repo.locate': '{"query"?: string, "symbol"?: string, "path"?: string, "line"?: number, "column"?: number, "scope"?: string[], "hierarchy"?: boolean}',
  'repo.diff': '{"path"?: string, "paths"?: string[], "staged"?: boolean, "base"?: string, "statOnly"?: boolean, "maxBytes"?: number}',
  'repo.apply_patch': '{"changes": [{"path": string, "find"?: string, "replace"?: string, "from"?: number, "to"?: number, "text"?: string, "create"?: boolean, "expectedDigest"?: string}]}',
  'repo.rollback': '{"journal": string}',
  'tool.batch': '{"actions": [{"id"?: string, "tool": string, "args"?: object}]}',
  'skill.load': '{"name": string}',
};

function attachSchemaHint(tool, res) {
  if (res && !res.ok && res.code === 'invalid_args' && SCHEMA_HINTS[tool] && !res.schema) {
    return { ...res, schema: SCHEMA_HINTS[tool] };
  }
  return res;
}

/**
 * Read-only structured git diff for workspace files, respecting .cursorignore
 * and secret filters.
 */
function diffRepo(workspace, args = {}) {
  workspace = canonicalRoot(workspace);
  const matcher = ignore.createIgnoreMatcher(workspace);
  const reqPaths = Array.isArray(args.paths) ? args.paths.map(String) : (args.path ? [String(args.path)] : []);
  for (const p of reqPaths) {
    const rel = String(p || '').replace(/^\.\//, '');
    const abs = insidePath(workspace, rel);
    if (!abs) return { ok: false, code: 'out_of_scope', error: 'path outside workspace: ' + rel };
    if (matcher.isCursorIgnored(rel)) return { ok: false, code: 'policy_denied', error: 'blocked by .cursorignore: ' + rel };
  }
  const base = args.base ? String(args.base).trim() : '';
  if (base && (base.startsWith('-') || !/^[A-Za-z0-9._\/~^@:]+$/.test(base))) {
    return { ok: false, code: 'invalid_args', error: 'invalid git base ref' };
  }
  const maxBytes = Math.max(1000, Math.min(48000, Number(args.maxBytes) || 24000));
  const execGit = (gitArgs) => execFileSync('git', gitArgs, {
    cwd: workspace, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  try {
    execGit(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { ok: false, code: 'tool_error', error: 'workspace is not a git repository' };
  }

  const baseArgs = ['diff', '--no-color'];
  if (args.staged) baseArgs.push('--staged');
  if (base) baseArgs.push(base);
  const statArgs = [...baseArgs, '--stat', ...(reqPaths.length ? ['--', ...reqPaths] : [])];
  const nameArgs = [...baseArgs, '--name-only', ...(reqPaths.length ? ['--', ...reqPaths] : [])];

  let stat = '';
  let files = [];
  try {
    stat = execGit(statArgs).trim();
    files = execGit(nameArgs).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return { ok: false, code: 'tool_error', error: 'git diff failed: ' + (e.message || e) };
  }

  const safeFiles = files.filter((f) => !matcher.isCursorIgnored(f) && !/(^|\/)(\.env|\.env\..*|.*\.pem|.*\.key)$/i.test(f));
  if (args.statOnly) {
    return { ok: true, data: { files: safeFiles, stat, diff: '', truncated: false, base: base || (args.staged ? 'STAGED' : 'WORKTREE') } };
  }

  let diff = '';
  if (safeFiles.length) {
    try {
      diff = execGit([...baseArgs, '--', ...safeFiles]);
    } catch (e) {
      return { ok: false, code: 'tool_error', error: 'git diff failed: ' + (e.message || e) };
    }
  }
  const truncated = Buffer.byteLength(diff) > maxBytes;
  if (truncated) diff = diff.slice(0, maxBytes) + '\n... (diff truncated)';
  return {
    ok: true,
    data: {
      files: safeFiles,
      stat,
      diff,
      truncated,
      base: base || (args.staged ? 'STAGED' : 'WORKTREE'),
    },
  };
}

function locateRepo(workspace, args = {}) {
  const query = String(args.query || args.symbol || '').trim();
  if (!query && !args.path) return { ok: false, code: 'invalid_args', error: 'query, symbol or path:line is required' };
  const scope = args.scope || ['.'];
  const found = query ? search.search(workspace, {
    query,
    scope,
    strategy: 'auto',
    limit: Math.max(1, Math.min(5, Number(args.limit) || 5)),
  }) : { ok: true, data: { hits: [], strategy: 'none' } };
  if (!found.ok) return found;
  const definitions = [];
  for (const hit of (found.data.hits || []).slice(0, 3)) {
    const read = search.read(workspace, {
      path: hit.path,
      from: Math.max(1, hit.from - 2),
      to: hit.to + 8,
    });
    definitions.push({
      path: hit.path,
      from: hit.from,
      to: hit.to,
      symbol: hit.symbol || '',
      reason: hit.reason,
      snippet: hit.snippet,
      digest: read.ok ? read.data.digest : null,
      text: read.ok ? read.data.text : '',
      truncated: read.ok ? read.data.truncated : false,
    });
  }
  let hierarchyData = null;
  if (args.hierarchy !== false && (args.symbol || args.path || query)) {
    hierarchyData = hierarchy.callHierarchy(workspace, {
      symbol: args.symbol || query,
      path: args.path,
      line: args.line,
      column: args.column,
      scope,
      limit: args.hierarchyLimit,
    });
    if (hierarchyData.ok && !definitions.length) {
      for (const def of hierarchyData.data.definitions || []) {
        const read = search.read(workspace, { path: def.path, from: Math.max(1, def.line - 2), to: def.line + 8 });
        definitions.push({
          path: def.path, from: def.line, to: def.line, symbol: def.symbol || hierarchyData.data.symbol,
          reason: 'symbol definition', snippet: read.ok ? read.data.text : def.text,
          digest: def.digest, text: read.ok ? read.data.text : '', truncated: false,
        });
      }
    }
  }
  const paths = [...new Set(definitions.map((d) => d.path))];
  const impact = paths.length ? impactRepo(workspace, { paths, scope: ['.'] }) : { ok: true, data: { affected: [] } };
  const tests = paths.length ? testsRepo(workspace, { paths, scope: ['.'] }) : { ok: true, data: { suggestions: [] } };
  return {
    ok: true,
    data: {
      query: query || hierarchyData?.data?.symbol || '',
      strategy: found.data.strategy,
      target: hierarchyData && hierarchyData.ok ? hierarchyData.data.target : null,
      definitions,
      affected: impact.ok ? impact.data.affected.slice(0, 10) : [],
      tests: tests.ok ? tests.data.suggestions.slice(0, 5) : [],
      callers: hierarchyData && hierarchyData.ok ? hierarchyData.data.callers : [],
      callees: hierarchyData && hierarchyData.ok ? hierarchyData.data.callees : [],
      unresolved: hierarchyData && hierarchyData.ok ? hierarchyData.data.unresolved : [],
      ambiguous: !!(hierarchyData && hierarchyData.ok && hierarchyData.data.ambiguous),
      coverage: hierarchyData && hierarchyData.ok ? hierarchyData.data.coverage : null,
      revision: hierarchyData && hierarchyData.ok ? hierarchyData.data.revision : null,
      truncated: definitions.some((d) => d.truncated),
      advisory: true,
    },
  };
}

function runBatch(workspace, args = {}, opts = {}) {
  const actions = Array.isArray(args.actions) ? args.actions.slice(0, 3) : [];
  if (!actions.length) return { ok: false, code: 'invalid_args', error: 'actions[] is required (max 3)' };
  const allowed = new Set(['repo.search', 'repo.read', 'repo.list', 'repo.map', 'repo.symbol', 'repo.references', 'repo.graph', 'repo.impact', 'repo.tests', 'repo.diff', 'repo.locate']);
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
  let res;
  switch (name) {
    case 'repo.search': res = search.search(workspace, args); break;
    case 'repo.read': res = search.read(workspace, args); break;
    case 'repo.list': res = search.list(workspace, args); break;
    case 'repo.map': res = mapRepo(workspace, args); break;
    case 'repo.symbol': res = symbolRepo(workspace, args); break;
    case 'repo.references': res = referencesRepo(workspace, args); break;
    case 'repo.graph': res = graphRepo(workspace, args); break;
    case 'repo.impact': res = impactRepo(workspace, args); break;
    case 'repo.tests': res = testsRepo(workspace, args); break;
    case 'repo.diff': res = diffRepo(workspace, args); break;
    case 'repo.locate': res = locateRepo(workspace, args); break;
    case 'workspace.diagnostics': res = diagnosticsRepo(workspace, args); break;
    case 'workspace.test': res = testRepo(workspace, args); break;
    case 'repo.apply_patch':
      if (opts.readonly) res = { ok: false, code: 'policy_denied', error: 'read-only mode' };
      else res = applyPatch(workspace, args, opts.actionId, opts);
      break;
    case 'repo.rollback':
      if (opts.readonly) res = { ok: false, code: 'policy_denied', error: 'read-only mode' };
      else res = rollback(workspace, args, opts.actionId);
      break;
    case 'tool.batch': res = runBatch(workspace, args, opts); break;
    default:
      res = { ok: false, code: 'invalid_args', error: 'unknown tool: ' + name };
  }
  return attachSchemaHint(name, res);
}

async function runToolAsync(workspace, name, args = {}, opts = {}) {
  if (name === 'tool.batch') return attachSchemaHint(name, await runBatchAsync(workspace, args, opts));
  if (name === 'repo.search' && (args.match === 'literal' || args.match === 'regex')) {
    return attachSchemaHint(name, await search.searchPatternAsync(workspace, args, opts));
  }
  if (name === 'repo.read') {
    // Keep range/digest semantics identical; the file read itself is cheap, but
    // yielding lets independent literal searches overlap with it.
    await new Promise((resolve) => setImmediate(resolve));
    if (opts.signal && opts.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    return attachSchemaHint(name, search.read(workspace, args));
  }
  await new Promise((resolve) => setImmediate(resolve));
  if (opts.signal && opts.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
  return runTool(workspace, name, args, opts);
}

function leafStatus(result) {
  if (!result || result.ok === false) {
    if (result && result.code === 'cancelled') return 'cancelled';
    if (result && result.code === 'timeout') return 'timeout';
    return 'error';
  }
  const data = result.data || {};
  if (data.truncated) return 'truncated';
  if (Array.isArray(data.hits) && data.hits.length === 0) return 'no_hits';
  if (Array.isArray(data.results) && data.results.every((r) => r.status === 'no_hits')) return 'no_hits';
  return 'ok';
}

function normalizeBatchAction(action, index) {
  return {
    id: action && action.id != null ? String(action.id) : String(index + 1),
    tool: String(action && action.tool || ''),
    args: (action && action.args && typeof action.args === 'object' && !Array.isArray(action.args))
      ? action.args : {},
  };
}

async function runBatchAsync(workspace, args = {}, opts = {}) {
  const raw = Array.isArray(args.actions) ? args.actions : [];
  if (!raw.length) return { ok: false, code: 'invalid_args', error: 'actions[] is required (max 3)' };
  const skipped = Math.max(0, raw.length - 3);
  const actions = raw.slice(0, 3).map(normalizeBatchAction);
  const allowed = new Set([
    'repo.search', 'repo.read', 'repo.list', 'repo.map', 'repo.symbol',
    'repo.references', 'repo.graph', 'repo.impact', 'repo.tests', 'repo.diff', 'repo.locate',
  ]);
  const started = Date.now();
  const results = new Array(actions.length);
  let scans = 0;

  const decide = (action) => {
    if (opts.decide) return opts.decide(action.tool, action.args);
    return { decision: 'allow', code: 'ok' };
  };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!allowed.has(action.tool)) {
      results[i] = {
        id: action.id, tool: action.tool, ok: false,
        code: 'policy_denied', error: 'not allowed in batch: ' + action.tool, status: 'error',
      };
      continue;
    }
    const decision = decide(action);
    if (decision.decision !== 'allow') {
      results[i] = {
        id: action.id, tool: action.tool, ok: false,
        code: decision.code || 'policy_denied', error: decision.reason || 'denied', status: 'error',
      };
    }
  }

  const pending = actions.map((action, i) => ({ action, i })).filter((item) => !results[item.i]);
  const allLiteral = pending.length > 1 && pending.every(({ action }) => (
    action.tool === 'repo.search' && action.args.match === 'literal'
  ));
  const sameGroup = allLiteral && pending.every(({ action }) => (
    JSON.stringify(action.args.scope || ['.']) === JSON.stringify(pending[0].action.args.scope || ['.'])
    && (action.args.caseSensitive === true) === (pending[0].action.args.caseSensitive === true)
    && (Number(action.args.limit) || 5) === (Number(pending[0].action.args.limit) || 5)
  ));

  if (sameGroup) {
    scans = 1;
    const grouped = await search.searchPatternGroupAsync(workspace, {
      queries: pending.map(({ action }) => ({ id: action.id, query: action.args.query })),
      scope: pending[0].action.args.scope || ['.'],
      caseSensitive: pending[0].action.args.caseSensitive === true,
      limit: Number(pending[0].action.args.limit) || 5,
      backend: pending[0].action.args.backend,
    }, opts);
    for (const { action, i } of pending) {
      if (!grouped.ok) {
        results[i] = { id: action.id, tool: action.tool, ok: false, code: grouped.code, error: grouped.error, status: leafStatus(grouped) };
        continue;
      }
      const group = grouped.data.groups[action.id] || { hits: [], truncated: false };
      results[i] = {
        id: action.id,
        tool: action.tool,
        ok: true,
        status: group.hits.length ? (group.truncated ? 'truncated' : 'ok') : 'no_hits',
        data: {
          query: action.args.query,
          match: 'literal',
          backend: grouped.data.backend,
          hits: group.hits,
          truncated: group.truncated,
          scanned: grouped.data.scanned,
          grouped: true,
        },
      };
    }
  } else {
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        if (opts.signal && opts.signal.aborted) {
          results[item.i] = {
            id: item.action.id, tool: item.action.tool, ok: false,
            code: 'cancelled', error: 'cancelled', status: 'cancelled',
          };
          continue;
        }
        if (opts.deadline && Date.now() > opts.deadline) {
          results[item.i] = {
            id: item.action.id, tool: item.action.tool, ok: false,
            code: 'timeout', error: 'batch deadline exceeded', status: 'timeout',
          };
          continue;
        }
        scans++;
        let result;
        try {
          const exec = opts.executor || runToolAsync;
          result = await exec(workspace, item.action.tool, item.action.args, opts);
        } catch (e) {
          result = { ok: false, code: 'tool_error', error: e.message };
        }
        results[item.i] = {
          id: item.action.id,
          tool: item.action.tool,
          ok: !!result.ok,
          status: leafStatus(result),
          ...(result.ok ? { data: result.data } : { code: result.code || 'tool_error', error: result.error }),
        };
      }
    };
    const workers = Array.from({ length: Math.min(2, pending.length) }, () => worker());
    await Promise.all(workers);
  }

  return {
    ok: true,
    data: {
      results,
      skipped,
      concurrency: sameGroup ? 1 : Math.min(2, pending.length),
      scans,
      durationMs: Date.now() - started,
    },
  };
}

module.exports = {
  runTool,
  runToolAsync,
  runBatchAsync,
  applyPatch,
  rollback,
  mapRepo,
  symbolRepo,
  referencesRepo,
  graphRepo,
  impactRepo,
  testsRepo,
  locateRepo,
  diffRepo,
  attachSchemaHint,
  SCHEMA_HINTS,
};
