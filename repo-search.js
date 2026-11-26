'use strict';

/*
 * Local, offline code search. Lexical baseline + BM25 + light structure and
 * Vietnamese/English query expansion. No embeddings, no network, no service.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ignore = require('./ignore');

const VERSION = 1;
const CACHE_DIR = ['.harness', 'index'];
const CACHE_FILE = 'repo-search-v1.json';
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.harness', 'node_modules', 'vendor', 'dist', 'build',
  'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '__pycache__',
  '.pytest_cache', '.venv', 'venv', 'Pods', 'DerivedData',
]);
const SKIP_RE = /(^|\/)(\.env|\.env\..*|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.log)$/i;
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.sh',
  '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c',
  '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.m', '.mm', '.sql',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.html', '.css', '.scss',
  '.less', '.xml', '.gradle', '.properties', '.dockerfile', '.makefile', '.mk',
]);
const SYMBOL_RE = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|def|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const SYNONYMS = {
  resume: ['restore', 'checkpoint', 'continue', 'session', 'tieptuc', 'khoiphuc'],
  restore: ['resume', 'checkpoint', 'continue'],
  checkpoint: ['resume', 'restore', 'session'],
  session: ['resume', 'checkpoint', 'state'],
  continue: ['resume', 'restore', 'next'],
  khoiphuc: ['resume', 'restore', 'checkpoint'],
  khoi: ['resume', 'restore', 'checkpoint'],
  phuc: ['restore', 'resume', 'checkpoint'],
  tieptuc: ['resume', 'continue', 'next'],
  phien: ['session', 'resume'],
  error: ['loi', 'failure', 'exception', 'fail'],
  loi: ['error', 'failure', 'exception'],
  verify: ['verification', 'check', 'test', 'kiemtra'],
  verification: ['verify', 'check', 'evidence'],
  kiemtra: ['check', 'verify', 'test'],
  test: ['spec', 'check', 'verify'],
  config: ['configuration', 'settings', 'cauhinh'],
  cauhinh: ['config', 'configuration', 'settings'],
  search: ['find', 'lookup', 'query', 'timkiem'],
  timkiem: ['search', 'find', 'query'],
  delete: ['remove', 'unlink', 'xoa'],
  xoa: ['delete', 'remove'],
  create: ['add', 'new', 'tao'],
  tao: ['create', 'add', 'new'],
  update: ['edit', 'patch', 'change', 'sua'],
  sua: ['update', 'edit', 'patch', 'fix'],
  bug: ['error', 'fail', 'loi'],
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function canonicalRoot(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function splitCamel(word) {
  return String(word)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

function foldVietnamese(word) {
  return String(word)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function tokenize(text) {
  const raw = String(text || '').normalize('NFKC');
  const out = new Set();
  const add = (word) => {
    const w = String(word || '').toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (w.length < 2 || w.length > 80) return;
    out.add(w);
    const folded = foldVietnamese(w);
    if (folded !== w) out.add(folded);
  };
  for (const match of raw.matchAll(/[\p{L}\p{N}_$./\\-]+/gu)) {
    const word = match[0];
    add(word);
    for (const part of word.split(/[./\\_-]+/)) {
      add(part);
      for (const camel of splitCamel(part)) add(camel);
    }
  }
  return [...out];
}

function queryTerms(query, strategy) {
  const base = tokenize(query);
  if (strategy === 'lexical') return base.map((term) => ({ term, weight: 1, source: 'query' }));
  const weights = new Map();
  for (const term of base) weights.set(term, 1);
  for (const term of base) {
    for (const syn of SYNONYMS[term] || []) {
      if (!weights.has(syn)) weights.set(syn, 0.45);
    }
  }
  return [...weights].map(([term, weight]) => ({ term, weight, source: weight === 1 ? 'query' : 'expansion' }));
}

function symbolAt(text) {
  SYMBOL_RE.lastIndex = 0;
  const m = SYMBOL_RE.exec(text);
  return m ? m[1] : '';
}

function chunkFile(rel, text) {
  const lines = String(text).split('\n');
  const chunks = [];
  const size = 40;
  const overlap = 8;
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(lines.length, start + size);
    const body = lines.slice(start, end).join('\n');
    if (!body.trim()) {
      if (end >= lines.length) break;
      continue;
    }
    chunks.push({
      from: start + 1,
      to: end,
      text: body,
      symbol: symbolAt(body),
      digest: sha256(body),
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function walk(root, scope, depthLimit = 12) {
  root = canonicalRoot(root);
  const matcher = ignore.createIgnoreMatcher(root);
  const files = [];
  const seen = new Set();
  const scopeList = Array.isArray(scope) && scope.length ? scope : ['.'];
  const roots = [];
  for (const s of scopeList) {
    const abs = path.resolve(root, String(s || '.'));
    if (!isInside(root, abs)) continue;
    let real;
    try { real = fs.realpathSync(abs); } catch { continue; }
    if (!isInside(root, real)) continue;
    roots.push(real);
  }
  const visit = (dir, depth) => {
    if (depth > depthLimit || files.length >= 5000) return;
    matcher.loadDir(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= 5000) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const relDir = toPosix(path.relative(root, full));
        if (!matcher.hasNegations() && matcher.ignores(relDir, true)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, full));
        if (SKIP_RE.test(rel) || matcher.ignores(rel, false)) continue;
        let real;
        try { real = fs.realpathSync(full); } catch { continue; }
        if (!isInside(root, real)) continue;
        const realRel = toPosix(path.relative(root, real));
        if (SKIP_RE.test(realRel) || matcher.ignores(realRel, false)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext && !TEXT_EXT.has(ext) && entry.name !== 'Makefile' && entry.name !== 'Dockerfile') continue;
        const key = rel;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ rel, abs: real });
      }
    }
  };
  for (const r of roots) {
    try {
      const st = fs.statSync(r);
      if (st.isFile()) {
        const rel = toPosix(path.relative(root, r));
        if (!SKIP_RE.test(rel) && !matcher.ignores(rel, false) && isInside(root, r)) files.push({ rel, abs: r });
      } else {
        visit(r, 0);
      }
    } catch {}
  }
  return files;
}

function readText(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (st.size > 512 * 1024) return null;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

function cachePath(root) {
  return path.join(root, ...CACHE_DIR, CACHE_FILE);
}

function loadCache(root) {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    if (data && data.version === VERSION && data.workspace === root) return data;
  } catch {}
  return { version: VERSION, workspace: root, files: {} };
}

function saveCache(root, cache) {
  try {
    const file = cachePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {}
}

function buildCache(root, scope, options = {}) {
  const started = Date.now();
  const deadline = started + (options.buildTimeoutMs || 5000);
  const cache = loadCache(root);
  const files = walk(root, scope);
  const next = {};
  let changed = 0;
  for (const file of files) {
    if (Date.now() > deadline) break;
    let st;
    try { st = fs.statSync(file.abs); } catch { continue; }
    const prev = cache.files[file.rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && Array.isArray(prev.chunks)) {
      next[file.rel] = prev;
      continue;
    }
    const text = readText(file.abs);
    if (text == null) continue;
    changed++;
    next[file.rel] = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      digest: sha256(text),
      chunks: chunkFile(file.rel, text),
    };
  }
  for (const rel of Object.keys(cache.files)) {
    if (!next[rel]) changed++;
  }
  const result = { version: VERSION, workspace: root, files: next, builtAt: Date.now(), changed };
  if (changed || !fs.existsSync(cachePath(root))) saveCache(root, result);
  return result;
}

function bm25(chunks, query, strategy) {
  const terms = queryTerms(query, strategy);
  const docs = [];
  const df = new Map();
  for (const rel of Object.keys(chunks)) {
    for (const chunk of chunks[rel].chunks) {
      const counts = new Map();
      for (const tok of tokenize(chunk.text + '\n' + rel)) counts.set(tok, (counts.get(tok) || 0) + 1);
      const length = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
      docs.push({ rel, chunk, counts, length });
      for (const [tok, count] of counts) if (count > 0) df.set(tok, (df.get(tok) || 0) + 1);
    }
  }
  const avg = docs.length ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 1;
  const k1 = 1.2;
  const b = 0.75;
  const hits = [];
  for (const doc of docs) {
    let score = 0;
    const matched = [];
    for (const t of terms) {
      const tf = doc.counts.get(t.term) || 0;
      if (!tf) continue;
      const n = df.get(t.term) || 1;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += t.weight * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / avg));
      matched.push(t.term);
    }
    const relLower = doc.rel.toLowerCase();
    const symLower = (doc.chunk.symbol || '').toLowerCase();
    for (const t of terms) {
      if (relLower.includes(t.term)) { score += 3.5 * t.weight; matched.push('path:' + t.term); }
      if (symLower && symLower === t.term) { score += 6 * t.weight; matched.push('symbol:' + t.term); }
    }
    const phrase = String(query).toLowerCase().trim();
    if (phrase && doc.chunk.text.toLowerCase().includes(phrase)) score += 5;
    if (score > 0) {
      hits.push({
        path: doc.rel,
        from: doc.chunk.from,
        to: doc.chunk.to,
        symbol: doc.chunk.symbol,
        score: Number(score.toFixed(3)),
        reason: [...new Set(matched)].slice(0, 6).join(', '),
        snippet: excerpt(doc.chunk.text, terms),
      });
    }
  }
  return hits;
}

function excerpt(text, terms) {
  const lines = String(text).split('\n');
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t.term)) score += t.weight;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const start = Math.max(0, best - 4);
  return lines.slice(start, start + 15).join('\n');
}

function dedupe(hits) {
  const out = [];
  for (const hit of hits.sort((a, b) => b.score - a.score)) {
    const overlap = out.some((h) => h.path === hit.path
      && Math.min(h.to, hit.to) - Math.max(h.from, hit.from) >= 2);
    if (!overlap) out.push(hit);
  }
  return out;
}

function patternLimit(args) {
  return Math.max(1, Math.min(20, Number(args.limit) || 5));
}

function rgAvailable() {
  if (rgAvailable.cached != null) return rgAvailable.cached;
  try {
    const r = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    rgAvailable.cached = r.status === 0;
  } catch {
    rgAvailable.cached = false;
  }
  return rgAvailable.cached;
}

function makeMatcher(args) {
  const query = String(args.query || '');
  const caseSensitive = args.caseSensitive === true;
  if (args.match === 'regex') {
    let re;
    try {
      re = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (e) {
      return { error: 'invalid regex: ' + e.message };
    }
    return {
      test: (line) => re.test(line),
      flags: caseSensitive ? [] : ['-i'],
      rg: ['-e', query],
    };
  }
  return {
    test: (line) => caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase()),
    flags: caseSensitive ? [] : ['-i'],
    rg: ['-F', '-e', query],
  };
}

function hitFromLine(rel, lines, index, matchIndex, column, reason) {
  const from = Math.max(0, index - 1);
  const snippet = lines.slice(from, Math.min(lines.length, index + 2)).join('\n');
  return {
    path: rel,
    from: index + 1,
    to: index + 1,
    line: index + 1,
    column: column + 1,
    symbol: '',
    score: 10,
    reason,
    snippet,
    matchIndex,
  };
}

function nodePatternScan(root, args, allowed, signal) {
  const matcher = makeMatcher(args);
  if (matcher.error) return { ok: false, code: 'invalid_args', error: matcher.error };
  const limit = patternLimit(args);
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const rel of allowed) {
    if (signal && signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    let text;
    try { text = readText(path.join(root, rel)); } catch { continue; }
    if (text == null) continue;
    scanned++;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let idx = -1;
      if (args.match === 'regex') {
        const m = line.match(matcher.re);
        idx = m ? m.index : -1;
      } else {
        idx = matcher.caseSensitive === true ? line.indexOf(args.query) : line.toLowerCase().indexOf(String(args.query).toLowerCase());
      }
      if (idx < 0) continue;
      hits.push(hitFromLine(rel, lines, i, idx, idx, args.match === 'regex' ? 'regex match' : 'literal match'));
      if (hits.length > limit) { truncated = true; break; }
    }
    if (hits.length > limit) break;
  }
  return {
    ok: true,
    data: {
      query: String(args.query),
      match: args.match,
      backend: 'node',
      hits: hydrateHits(root, hits.slice(0, limit), args),
      truncated: truncated || hits.length > limit,
      scanned,
    },
  };
}

function parseRgOutput(stdout, allowed, limit) {
  const hits = [];
  let truncated = false;
  for (const raw of String(stdout || '').split('\n')) {
    if (!raw) continue;
    let m = raw.match(/^(.*?):(\d+):(\d+):(.*)$/);
    let rel;
    let line;
    let col;
    if (m) {
      rel = m[1]; line = Number(m[2]); col = Number(m[3]);
    } else {
      m = raw.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      rel = m[1]; line = Number(m[2]); col = 1;
    }
    rel = rel.replace(/^\.\//, '').split(path.sep).join('/');
    if (!allowed.has(rel)) continue;
    hits.push({ path: rel, from: line, to: line, line, column: col, symbol: '', score: 10, snippet: '', reason: 'pattern match', matchIndex: 0 });
    if (hits.length > limit) { truncated = true; break; }
  }
  return { hits: hits.slice(0, limit), truncated };
}

function hydrateHits(root, hits, args) {
  const cache = new Map();
  for (const hit of hits) {
    let lines = cache.get(hit.path);
    if (!lines) {
      let text = '';
      try { text = readText(path.join(root, hit.path)) || ''; } catch {}
      lines = text.split('\n');
      cache.set(hit.path, lines);
    }
    const idx = hit.line - 1;
    const line = lines[idx] || '';
    const from = Math.max(0, idx - 1);
    hit.snippet = lines.slice(from, Math.min(lines.length, idx + 2)).join('\n').slice(0, 1200);
    hit.matchText = line.trim().slice(0, 300);
    let count = 0;
    if (args.match === 'regex') {
      try {
        const re = new RegExp(args.query, 'g' + (args.caseSensitive === true ? '' : 'i'));
        count = [...line.matchAll(re)].length;
      } catch {}
    } else {
      const hay = args.caseSensitive === true ? line : line.toLowerCase();
      const needle = args.caseSensitive === true ? args.query : String(args.query).toLowerCase();
      let at = 0;
      while (needle && (at = hay.indexOf(needle, at)) >= 0) { count++; at += Math.max(1, needle.length); }
    }
    hit.matchCount = count || 1;
  }
  return hits;
}

function searchPatternSync(root, args) {
  const allowedFiles = walk(root, args.scope || ['.']);
  const allowed = new Set(allowedFiles.map((f) => f.rel));
  if (args.backend === 'node' || !rgAvailable()) {
    return nodePatternScan(root, args, allowed, null);
  }
  const matcher = makeMatcher(args);
  if (matcher.error) return { ok: false, code: 'invalid_args', error: matcher.error };
  const limit = patternLimit(args);
  const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', ...matcher.flags, ...matcher.rg, '.'];
  const started = Date.now();
  const r = spawnSync('rg', rgArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(args.timeoutMs) || 10000),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error && r.error.code === 'ENOENT') {
    return nodePatternScan(root, args, allowed, null);
  }
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { ok: false, code: 'timeout', error: 'search timed out' };
  }
  if (r.status != null && ![0, 1].includes(r.status)) {
    return { ok: false, code: 'tool_error', error: 'rg failed: ' + String(r.stderr || '').slice(0, 500) };
  }
  const parsed = parseRgOutput(r.stdout, allowed, limit);
  return {
    ok: true,
    data: {
      query: String(args.query),
      match: args.match,
      backend: 'rg',
      hits: hydrateHits(root, parsed.hits, args),
      truncated: parsed.truncated,
      scanned: allowed.size,
      durationMs: Date.now() - started,
    },
  };
}

async function searchPatternAsync(root, args, opts = {}) {
  const allowedFiles = walk(root, args.scope || ['.']);
  const allowed = new Set(allowedFiles.map((f) => f.rel));
  if (args.backend === 'node' || !rgAvailable()) {
    return nodePatternScan(root, args, allowed, opts.signal);
  }
  const matcher = makeMatcher(args);
  if (matcher.error) return { ok: false, code: 'invalid_args', error: matcher.error };
  const limit = patternLimit(args);
  const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', ...matcher.flags, ...matcher.rg, '.'];
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn('rg', rgArgs, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: opts.signal,
      });
    } catch (e) {
      finish(nodePatternScan(root, args, allowed, opts.signal));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, code: 'timeout', error: 'search timed out' });
    }, Math.max(1000, Number(opts.timeoutMs || args.timeoutMs) || 10000));
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, code: 'cancelled', error: 'cancelled' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); if (stdout.length > 8 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch {} } });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (opts.signal && opts.signal.aborted) finish({ ok: false, code: 'cancelled', error: 'cancelled' });
      else finish(nodePatternScan(root, args, allowed, opts.signal));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.signal && opts.signal.aborted) {
        finish({ ok: false, code: 'cancelled', error: 'cancelled' });
        return;
      }
      if (code != null && ![0, 1].includes(code)) {
        finish({ ok: false, code: 'tool_error', error: 'rg failed: ' + stderr.slice(0, 500) });
        return;
      }
      const parsed = parseRgOutput(stdout, allowed, limit);
      finish({
        ok: true,
        data: {
          query: String(args.query),
          match: args.match,
          backend: 'rg',
          hits: hydrateHits(root, parsed.hits, args),
          truncated: parsed.truncated,
          scanned: allowed.size,
        },
      });
    });
  });
}

async function searchPatternGroupAsync(root, args, opts = {}) {
  root = canonicalRoot(root);
  const queries = Array.isArray(args.queries) ? args.queries.filter((q) => q && q.query) : [];
  if (!queries.length) return { ok: true, data: { groups: {}, scans: 0, backend: 'none' } };
  const allowedFiles = walk(root, args.scope || ['.']);
  const allowed = new Set(allowedFiles.map((f) => f.rel));
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const caseSensitive = args.caseSensitive === true;
  const groups = {};
  for (const q of queries) groups[q.id] = { hits: [], truncated: false };
  let backend = 'node';
  let scanned = 0;

  const assign = (rel, lineNo, col, line) => {
    const hay = caseSensitive ? line : line.toLowerCase();
    const lines = line;
    for (const q of queries) {
      const needle = caseSensitive ? q.query : String(q.query).toLowerCase();
      if (!hay.includes(needle)) continue;
      if (groups[q.id].hits.length >= limit) {
        groups[q.id].truncated = true;
        continue;
      }
      groups[q.id].hits.push({
        path: rel, from: lineNo, to: lineNo, line: lineNo, column: col + 1,
        symbol: '', score: 10, reason: 'literal match (grouped)', snippet: lines.trim().slice(0, 1200),
        matchText: line.trim().slice(0, 300), matchCount: 1,
      });
    }
  };

  if (args.backend !== 'node' && rgAvailable()) {
    backend = 'rg';
    const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', '-F'];
    if (!caseSensitive) rgArgs.push('-i');
    for (const q of queries) rgArgs.push('-e', String(q.query));
    rgArgs.push('.');
    const stdout = await new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawn('rg', rgArgs, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], signal: opts.signal });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, Math.max(1000, Number(opts.timeoutMs) || 10000));
      child.stdout.on('data', (b) => { out += b.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code != null && ![0, 1].includes(code)) reject(new Error('rg failed'));
        else resolve(out);
      });
    }).catch(() => null);
    if (stdout != null) {
      for (const raw of stdout.split('\n')) {
        if (!raw) continue;
        let m = raw.match(/^(.*?):(\d+):(\d+):(.*)$/);
        let rel, lineNo, col, line;
        if (m) { rel = m[1]; lineNo = Number(m[2]); col = Number(m[3]); line = m[4]; }
        else {
          m = raw.match(/^(.*?):(\d+):(.*)$/);
          if (!m) continue;
          rel = m[1]; lineNo = Number(m[2]); col = 1; line = m[3];
        }
        rel = rel.replace(/^\.\//, '').split(path.sep).join('/');
        if (!allowed.has(rel)) continue;
        assign(rel, lineNo, col, line);
      }
      scanned = allowed.size;
      return { ok: true, data: { groups, scans: 1, backend, scanned } };
    }
  }

  for (const rel of allowed) {
    if (opts.signal && opts.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    let text = '';
    try { text = readText(path.join(root, rel)) || ''; } catch {}
    if (!text) continue;
    scanned++;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) assign(rel, i + 1, 1, lines[i]);
  }
  return { ok: true, data: { groups, scans: 1, backend, scanned } };
}

function search(root, args = {}) {
  root = canonicalRoot(root);
  const query = String(args.query || '').trim().slice(0, 500);
  if (!query) return { ok: false, code: 'invalid_args', error: 'query is required' };
  if (args.match === 'literal' || args.match === 'regex') {
    return searchPatternSync(root, { ...args, query });
  }
  const strategy = ['auto', 'lexical', 'hybrid'].includes(args.strategy) ? args.strategy : 'auto';
  const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
  const scope = Array.isArray(args.scope) ? args.scope : (args.scope ? [args.scope] : ['.']);
  const started = Date.now();
  const cache = buildCache(root, scope, { buildTimeoutMs: Number(args.buildTimeoutMs) || 5000 });
  const terms = queryTerms(query, 'lexical');
  const exact = [];
  for (const rel of Object.keys(cache.files)) {
    const lower = rel.toLowerCase();
    if (terms.some((t) => lower.includes(t.term))) {
      for (const chunk of cache.files[rel].chunks.slice(0, 1)) {
        exact.push({
          path: rel, from: chunk.from, to: chunk.to, symbol: chunk.symbol,
          score: 9, reason: 'exact path', snippet: excerpt(chunk.text, terms),
        });
      }
    }
  }
  const mode = strategy === 'auto' && exact.length ? 'lexical' : strategy;
  const hits = dedupe([...exact, ...bm25(cache.files, query, mode === 'auto' ? 'hybrid' : mode)]).slice(0, limit);
  return {
    ok: true,
    data: {
      query,
      strategy: mode,
      hits,
      index: {
        files: Object.keys(cache.files).length,
        changed: cache.changed,
        builtAt: cache.builtAt,
        durationMs: Date.now() - started,
      },
    },
  };
}

function read(root, args = {}) {
  root = canonicalRoot(root);
  const rel = String(args.path || '').replace(/^\.\//, '');
  if (!rel) return { ok: false, code: 'invalid_args', error: 'path is required' };
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) return { ok: false, code: 'out_of_scope', error: 'path is outside workspace' };
  let real;
  try { real = fs.realpathSync(abs); } catch { return { ok: false, code: 'not_found', error: 'file not found' }; }
  if (!isInside(root, real)) return { ok: false, code: 'out_of_scope', error: 'symlink escapes workspace' };
  const realRel = toPosix(path.relative(root, real));
  const matcher = ignore.createIgnoreMatcher(root);
  if (SKIP_RE.test(realRel) || matcher.isCursorIgnored(realRel, false)) {
    return { ok: false, code: 'policy_denied', error: 'blocked by .cursorignore / secret filter: ' + realRel };
  }
  const text = readText(real);
  if (text == null) return { ok: false, code: 'tool_error', error: 'not a readable text file' };
  const digest = 'sha256:' + sha256(text);
  if (args.expectedDigest && String(args.expectedDigest) !== digest) {
    return { ok: false, code: 'stale_revision', error: 'digest mismatch', data: { digest } };
  }
  const lines = text.split('\n');
  let from = Math.max(1, Number(args.from) || 1);
  let to = Math.min(lines.length, Number(args.to) || lines.length);
  if (to < from) [from, to] = [to, from];
  const maxLines = 400;
  const truncated = to - from + 1 > maxLines;
  if (truncated) to = from + maxLines - 1;
  const body = lines.slice(from - 1, to).join('\n');
  return {
    ok: true,
    data: {
      path: toPosix(path.relative(root, real)),
      from,
      to,
      digest,
      text: body,
      truncated,
    },
  };
}

function list(root, args = {}) {
  const scope = Array.isArray(args.scope) ? args.scope : (args.scope ? [args.scope] : ['.']);
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 120));
  const depth = Math.max(0, Math.min(12, Number(args.depth) || 4));
  const files = walk(root, scope, depth).slice(0, limit).map((f) => f.rel);
  return { ok: true, data: { files, truncated: files.length >= limit } };
}

module.exports = {
  VERSION,
  tokenize,
  queryTerms,
  splitCamel,
  sha256,
  search,
  searchPatternAsync,
  searchPatternGroupAsync,
  read,
  list,
  walk,
  cachePath,
};
