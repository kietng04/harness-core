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
        // Directory recursion never follows symlinks and the root itself was
        // realpath-resolved, so a regular file here cannot escape the root.
        // Avoid realpathSync per file: it dominates walk time on large trees.
        const rel = toPosix(path.relative(root, full));
        if (SKIP_RE.test(rel) || matcher.ignores(rel, false)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext && !TEXT_EXT.has(ext) && entry.name !== 'Makefile' && entry.name !== 'Dockerfile') continue;
        const key = rel;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ rel, abs: full });
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

const MAX_TEXT_BYTES = 512 * 1024;

function readText(abs) {
  const buf = readBuffer(abs);
  return buf == null ? null : buf.toString('utf8');
}

function readBuffer(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (st.size > MAX_TEXT_BYTES) return null;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.includes(0)) return null;
  return buf;
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

/* ---------------------------------------------------- trigram instant grep */

const TRIGRAM_VERSION = 2;
const TRIGRAM_FILE = 'trigram-v2.json';
const BLOOM_BYTES = 512;
const BLOOM_BITS = BLOOM_BYTES * 8;
const BLOOM_MASK = BLOOM_BITS - 1;
const BLOOM_K = 6;
const BLOOM_MAX_FILE = 128 * 1024;
let trigramRuntime = null;

function trigramPath(root) {
  return path.join(canonicalRoot(root), ...CACHE_DIR, TRIGRAM_FILE);
}

function resetTrigramCache() {
  trigramRuntime = null;
}

function triHash(a, b, c) {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ a, 0x01000193);
  h = Math.imul(h ^ b, 0x01000193);
  h = Math.imul(h ^ c, 0x01000193);
  return h >>> 0;
}

/*
 * Bloom filter over byte trigrams (ASCII-folded). No false negatives, so the
 * confirmation scan stays authoritative; a larger index only means extra files
 * are scanned. This replaces the old file -> trigram-array + postings JSON,
 * which grew to roughly the source size and cost 40ms+ to parse.
 */
function bloomForBuffer(buf) {
  const bytes = Buffer.alloc(BLOOM_BYTES);
  const folded = asciiFoldBuffer(buf);
  for (let i = 0; i + 2 < folded.length; i++) {
    const h = triHash(folded[i], folded[i + 1], folded[i + 2]);
    const h2 = ((h >>> 16) ^ h) | 1;
    for (let k = 0; k < BLOOM_K; k++) {
      const bit = (h + Math.imul(k, h2)) & BLOOM_MASK;
      bytes[bit >> 3] |= 1 << (bit & 7);
    }
  }
  return bytes.toString('base64');
}

function bloomHas(bytes, h) {
  const h2 = ((h >>> 16) ^ h) | 1;
  for (let k = 0; k < BLOOM_K; k++) {
    const bit = (h + Math.imul(k, h2)) & BLOOM_MASK;
    if (!(bytes[bit >> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}

function decodedBloom(entry) {
  if (entry._bloom) return entry._bloom;
  const bytes = Buffer.from(entry.bloom || '', 'base64');
  Object.defineProperty(entry, '_bloom', { value: bytes, enumerable: false, configurable: true });
  return bytes;
}

function loadTrigram(root) {
  if (trigramRuntime && trigramRuntime.workspace === canonicalRoot(root)) return trigramRuntime;
  try {
    const data = JSON.parse(fs.readFileSync(trigramPath(root), 'utf8'));
    if (data && data.version === TRIGRAM_VERSION && data.workspace === canonicalRoot(root)) {
      data.files = data.files || {};
      trigramRuntime = data;
      return data;
    }
  } catch {}
  trigramRuntime = {
    version: TRIGRAM_VERSION,
    workspace: canonicalRoot(root),
    files: {},
    complete: false,
    builtAt: 0,
  };
  return trigramRuntime;
}

function saveTrigram(root, index) {
  try {
    fs.mkdirSync(path.dirname(trigramPath(root)), { recursive: true });
    const tmp = trigramPath(root) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, trigramPath(root));
  } catch {}
}

function ensureTrigramIndex(root, options = {}) {
  root = canonicalRoot(root);
  const started = Date.now();
  const maxMs = Math.max(50, Number(options.maxMs) || 3000);
  const index = loadTrigram(root);
  const files = walk(root, ['.']);
  const seen = new Set();
  let updated = 0;
  let complete = true;
  for (const file of files) {
    if (Date.now() - started > maxMs) { complete = false; break; }
    let st;
    try { st = fs.statSync(file.abs); } catch { continue; }
    const prev = index.files[file.rel];
    seen.add(file.rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && typeof prev.bloom === 'string') continue;
    const buf = readBuffer(file.abs);
    if (buf == null) {
      if (prev) { delete index.files[file.rel]; updated++; }
      continue;
    }
    index.files[file.rel] = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      bloom: buf.length > BLOOM_MAX_FILE ? '' : bloomForBuffer(buf),
    };
    updated++;
  }
  if (complete) {
    for (const rel of Object.keys(index.files)) {
      if (!seen.has(rel)) { delete index.files[rel]; updated++; }
    }
  }
  index.complete = complete;
  index.builtAt = index.builtAt || Date.now();
  if (updated || !index.builtAt) saveTrigram(root, index);
  return {
    index,
    complete,
    files: Object.keys(index.files).length,
    updated,
    durationMs: Date.now() - started,
  };
}

function trigramCandidates(index, query, limitFiles = 2000) {
  const q = asciiFoldBuffer(Buffer.from(String(query || ''), 'utf8'));
  if (q.length < 3) return null;
  const hashes = [];
  const seen = new Set();
  for (let i = 0; i + 2 < q.length; i++) {
    const h = triHash(q[i], q[i + 1], q[i + 2]);
    if (seen.has(h)) continue;
    seen.add(h);
    hashes.push(h);
  }
  if (!hashes.length) return null;
  const out = [];
  for (const rel of Object.keys(index.files)) {
    const entry = index.files[rel];
    if (entry.bloom === '') { out.push(rel); continue; }
    if (entry.bloom == null) { out.push(rel); continue; }
    const bloom = decodedBloom(entry);
    let match = true;
    for (const h of hashes) {
      if (!bloomHas(bloom, h)) { match = false; break; }
    }
    if (match) out.push(rel);
    if (out.length > limitFiles) return null;
  }
  return out;
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
      re,
      query,
      match: 'regex',
      caseSensitive,
      flags: caseSensitive ? [] : ['-i'],
      rg: ['-e', query],
    };
  }
  return {
    test: (line) => caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase()),
    re: null,
    query,
    match: 'literal',
    caseSensitive,
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

const NL_BYTE = 0x0a;

function isAsciiText(text) {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

function hasNonAsciiBytes(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) return true;
  return false;
}

/*
 * Byte-level ASCII case folding. Latin-1 maps bytes 1:1 and only A-Z change;
 * every non-ASCII byte stays >= 0x80, so UTF-8 sequences keep their offsets
 * and can never be hit by an ASCII needle.
 */
function asciiFoldBuffer(buf) {
  return Buffer.from(buf.toString('latin1').toLowerCase(), 'latin1');
}

function bufferLineBounds(buf, idx) {
  const lineStart = idx === 0 ? 0 : buf.lastIndexOf(NL_BYTE, idx - 1) + 1;
  const nl = buf.indexOf(NL_BYTE, idx);
  const lineEnd = nl === -1 ? buf.length : nl;
  return { lineStart, lineEnd };
}

function byteColumn(buf, lineStart, idx) {
  const prefix = buf.subarray(lineStart, idx);
  const col = hasNonAsciiBytes(prefix) ? prefix.toString('utf8').length : prefix.length;
  return col + 1;
}

function bufferSnippet(buf, lineStart, lineEnd, maxLen = 1200) {
  const start = lineStart < 2 ? 0 : buf.lastIndexOf(NL_BYTE, lineStart - 2) + 1;
  let end = lineEnd;
  if (end < buf.length) {
    const nextNl = buf.indexOf(NL_BYTE, end + 1);
    end = nextNl === -1 ? buf.length : nextNl;
  }
  return buf.subarray(start, end).toString('utf8').slice(0, maxLen);
}

function countOccurrences(hay, needle, start, end) {
  let count = 0;
  let at = start;
  const step = needle.length || 1;
  while (at < end) {
    at = hay.indexOf(needle, at);
    if (at === -1 || at >= end) break;
    count++;
    at += step;
  }
  return count;
}

/*
 * One file, one query, one pass. `displayBuf` keeps original bytes for text;
 * `hay` may be ASCII-folded (same length, same offsets) for case-insensitive.
 */
function scanLiteralBuffer(displayBuf, hay, needle, rel, limit, lineSnippet = false) {
  const hits = [];
  let truncated = false;
  let lineNo = 1;
  let lastNl = -1;
  let nlScan = 0;
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    while (true) {
      const nl = hay.indexOf(NL_BYTE, nlScan);
      if (nl === -1 || nl >= idx) break;
      lineNo++;
      lastNl = nl;
      nlScan = nl + 1;
    }
    if (hits.length >= limit) { truncated = true; break; }
    const { lineStart, lineEnd } = bufferLineBounds(displayBuf, idx);
    const lineText = displayBuf.subarray(lineStart, lineEnd).toString('utf8');
    hits.push({
      path: rel,
      from: lineNo,
      to: lineNo,
      line: lineNo,
      column: byteColumn(displayBuf, lineStart, idx),
      symbol: '',
      score: 10,
      reason: lineSnippet ? 'literal match (grouped)' : 'literal match',
      snippet: lineSnippet ? lineText.trim().slice(0, 1200) : bufferSnippet(displayBuf, lineStart, lineEnd),
      matchText: lineText.trim().slice(0, 300),
      matchCount: countOccurrences(hay, needle, lineStart, lineEnd) || 1,
      matchIndex: idx,
    });
    // Match rg/legacy behavior: one hit per line, count all occurrences in it.
    from = lineEnd < hay.length ? lineEnd + 1 : hay.length + 1;
  }
  return { hits, truncated };
}

function nodeLiteralScanFast(root, args, allowed, signal) {
  const query = String(args.query || '');
  const caseSensitive = args.caseSensitive === true;
  const limit = patternLimit(args);
  const fold = !caseSensitive && /[A-Za-z]/.test(query);
  const needle = fold ? Buffer.from(query.toLowerCase(), 'utf8') : Buffer.from(query, 'utf8');
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const rel of allowed) {
    if (signal && signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    if (hits.length >= limit) {
      // One more match anywhere means the result is truncated; no need to
      // build another hit object.
      let bufProbe;
      try { bufProbe = readBuffer(path.join(root, rel)); } catch { continue; }
      if (bufProbe == null) continue;
      scanned++;
      const hayProbe = fold ? asciiFoldBuffer(bufProbe) : bufProbe;
      if (hayProbe.indexOf(needle) !== -1) { truncated = true; break; }
      continue;
    }
    let buf;
    try { buf = readBuffer(path.join(root, rel)); } catch { continue; }
    if (buf == null) continue;
    scanned++;
    const hay = fold ? asciiFoldBuffer(buf) : buf;
    const result = scanLiteralBuffer(buf, hay, needle, rel, limit - hits.length);
    for (const hit of result.hits) hits.push(hit);
    if (result.truncated) { truncated = true; break; }
  }
  return {
    ok: true,
    data: {
      query,
      match: 'literal',
      backend: 'node',
      hits,
      truncated,
      scanned,
    },
  };
}

function nodeRegexScan(root, args, allowed, signal) {
  const source = String(args.query || '');
  const caseSensitive = args.caseSensitive === true;
  const flags = 'gm' + (caseSensitive ? '' : 'i');
  let re;
  let countRe;
  try {
    re = new RegExp(source, flags);
    countRe = new RegExp(source, 'g' + (caseSensitive ? '' : 'i'));
  } catch (e) {
    return { ok: false, code: 'invalid_args', error: 'invalid regex: ' + e.message };
  }
  const limit = patternLimit(args);
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const rel of allowed) {
    if (signal && signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    let buf;
    try { buf = readBuffer(path.join(root, rel)); } catch { continue; }
    if (buf == null) continue;
    scanned++;
    const text = buf.toString('utf8');
    let lineNo = 1;
    let lastNl = -1;
    let nlScan = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0].indexOf('\n') !== -1) {
        // The legacy scanner matched line-by-line; never match across lines.
        re.lastIndex = m.index + 1;
        continue;
      }
      while (true) {
        const nl = text.indexOf('\n', nlScan);
        if (nl === -1 || nl >= m.index) break;
        lineNo++;
        lastNl = nl;
        nlScan = nl + 1;
      }
      if (hits.length >= limit) { truncated = true; break; }
      const lineStart = lastNl + 1;
      const lineNl = text.indexOf('\n', m.index);
      const lineEnd = lineNl === -1 ? text.length : lineNl;
      const line = text.slice(lineStart, lineEnd);
      // Legacy matched a line including its trailing CR, so `$` sat after it.
      const column = m.index - lastNl + (m[0].length === 0 && text.charCodeAt(m.index) === 0x0d ? 1 : 0);
      const start = lineStart < 2 ? 0 : text.lastIndexOf('\n', lineStart - 2) + 1;
      let end = lineEnd;
      if (end < text.length) {
        const nextNl = text.indexOf('\n', end + 1);
        end = nextNl === -1 ? text.length : nextNl;
      }
      countRe.lastIndex = 0;
      let count = 0;
      let cm;
      while ((cm = countRe.exec(line))) {
        count++;
        if (cm[0].length === 0) countRe.lastIndex++;
      }
      hits.push({
        path: rel,
        from: lineNo,
        to: lineNo,
        line: lineNo,
        column,
        symbol: '',
        score: 10,
        reason: 'regex match',
        snippet: text.slice(start, end).slice(0, 1200),
        matchText: line.trim().slice(0, 300),
        matchCount: count || 1,
        matchIndex: m.index,
      });
      // One hit per line, like rg/legacy; continue at the next line start.
      re.lastIndex = lineEnd < text.length ? lineEnd + 1 : text.length + 1;
    }
    if (truncated) break;
  }
  return {
    ok: true,
    data: {
      query: source,
      match: 'regex',
      backend: 'node',
      hits,
      truncated,
      scanned,
    },
  };
}

// Exact legacy semantics for Unicode case-insensitive and multiline literals.
function nodePatternScanLegacy(root, args, allowed, signal) {
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

function nodePatternScan(root, args, allowed, signal) {
  if (args.match === 'regex') return nodeRegexScan(root, args, allowed, signal);
  const query = String(args.query || '');
  if (query.includes('\n') || query.includes('\r')) {
    return nodePatternScanLegacy(root, args, allowed, signal);
  }
  if (args.caseSensitive !== true && !isAsciiText(query)) {
    return nodePatternScanLegacy(root, args, allowed, signal);
  }
  return nodeLiteralScanFast(root, args, allowed, signal);
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

function relativeScopes(root, scope) {
  const list = Array.isArray(scope) && scope.length ? scope : ['.'];
  const out = [];
  for (const s of list) {
    const abs = path.resolve(root, String(s || '.'));
    const rel = toPosix(path.relative(root, abs));
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) continue;
    out.push(rel === '.' ? '' : rel);
  }
  return out;
}

function inScope(rel, scopes) {
  return scopes.some((s) => s === '' || rel === s || rel.startsWith(s + '/'));
}

function preparePattern(root, args) {
  let candidates = null;
  let indexMeta = null;
  const queryText = String(args.query || '');
  // Unicode case-insensitive matching needs JS lowercasing, but the bloom is
  // ASCII-folded; skip the index so it can never hide such a match.
  const indexableQuery = args.caseSensitive === true || isAsciiText(queryText);
  if (args.match === 'literal' && queryText.length >= 3 && args.instant !== false && indexableQuery) {
    try {
      const built = ensureTrigramIndex(root, { maxMs: Number(args.indexMaxMs) || 3000 });
      if (built.complete) {
        const found = trigramCandidates(built.index, args.query);
        if (found !== null) {
          // ensureTrigramIndex just refreshed the index from walk(), so every
          // candidate already passed ignore/extension/secret/existence checks.
          // Scope is the only remaining filter; skip the full tree walk.
          const scopes = relativeScopes(root, args.scope);
          candidates = found.filter((rel) => inScope(rel, scopes));
          indexMeta = {
            used: true,
            files: built.files,
            updated: built.updated,
            candidates: candidates.length,
            durationMs: built.durationMs,
          };
          return { allowed: new Set(candidates), candidates, indexMeta };
        }
      } else {
        indexMeta = {
          used: false,
          fallback: 'index incomplete',
          files: built.files,
          updated: built.updated,
        };
      }
    } catch (e) {
      indexMeta = { used: false, fallback: e.message };
    }
  }
  const allowedFiles = walk(root, args.scope || ['.']);
  const allowed = new Set(allowedFiles.map((f) => f.rel));
  return { allowed, candidates, indexMeta };
}

function searchPatternSync(root, args) {
  const { allowed, candidates, indexMeta } = preparePattern(root, args);
  const scanSet = candidates !== null ? new Set(candidates) : allowed;
  if (candidates !== null && candidates.length === 0) {
    return {
      ok: true,
      data: {
        query: String(args.query), match: args.match, backend: 'index',
        hits: [], truncated: false, scanned: 0, index: indexMeta,
      },
    };
  }
  if (args.backend === 'node' || !rgAvailable()) {
    const result = nodePatternScan(root, args, scanSet, null);
    if (result.ok) result.data.index = indexMeta;
    return result;
  }
  const matcher = makeMatcher(args);
  if (matcher.error) return { ok: false, code: 'invalid_args', error: matcher.error };
  const limit = patternLimit(args);
  const targets = candidates !== null ? candidates : ['.'];
  const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', '-H', ...matcher.flags, ...matcher.rg, ...targets];
  const started = Date.now();
  const r = spawnSync('rg', rgArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(args.timeoutMs) || 10000),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error && r.error.code === 'ENOENT') {
    const result = nodePatternScan(root, args, scanSet, null);
    if (result.ok) result.data.index = indexMeta;
    return result;
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
      scanned: scanSet.size,
      index: indexMeta,
      durationMs: Date.now() - started,
    },
  };
}

async function searchPatternAsync(root, args, opts = {}) {
  const { allowed, candidates, indexMeta } = preparePattern(root, args);
  const scanSet = candidates !== null ? new Set(candidates) : allowed;
  if (candidates !== null && candidates.length === 0) {
    return {
      ok: true,
      data: {
        query: String(args.query), match: args.match, backend: 'index',
        hits: [], truncated: false, scanned: 0, index: indexMeta,
      },
    };
  }
  if (args.backend === 'node' || !rgAvailable()) {
    const result = nodePatternScan(root, args, scanSet, opts.signal);
    if (result.ok) result.data.index = indexMeta;
    return result;
  }
  const matcher = makeMatcher(args);
  if (matcher.error) return { ok: false, code: 'invalid_args', error: matcher.error };
  const limit = patternLimit(args);
  const targets = candidates !== null ? candidates : ['.'];
  const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', '-H', ...matcher.flags, ...matcher.rg, ...targets];
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
      const fallback = nodePatternScan(root, args, scanSet, opts.signal);
      if (fallback.ok) fallback.data.index = indexMeta;
      finish(fallback);
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
      else {
        const fallback = nodePatternScan(root, args, scanSet, opts.signal);
        if (fallback.ok) fallback.data.index = indexMeta;
        finish(fallback);
      }
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
          scanned: scanSet.size,
          index: indexMeta,
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

  const assign = (rel, lineNo, col, line, subset = queries) => {
    const hay = caseSensitive ? line : line.toLowerCase();
    for (const q of subset) {
      const needle = caseSensitive ? String(q.query) : String(q.query).toLowerCase();
      if (!hay.includes(needle)) continue;
      if (groups[q.id].hits.length >= limit) {
        groups[q.id].truncated = true;
        continue;
      }
      const idx = hay.indexOf(needle);
      let count = 0;
      let at = 0;
      while (needle && (at = hay.indexOf(needle, at)) >= 0) { count++; at += Math.max(1, needle.length); }
      groups[q.id].hits.push({
        path: rel, from: lineNo, to: lineNo, line: lineNo, column: idx + 1,
        symbol: '', score: 10, reason: 'literal match (grouped)', snippet: line.trim().slice(0, 1200),
        matchText: line.trim().slice(0, 300), matchCount: count || 1,
      });
    }
  };

  if (args.backend !== 'node' && rgAvailable()) {
    backend = 'rg';
    const rgArgs = ['-n', '--column', '--no-heading', '--color', 'never', '--no-messages', '-H', '-F'];
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

  const fastQueries = [];
  const slowQueries = [];
  for (const q of queries) {
    const query = String(q.query);
    const ascii = isAsciiText(query) && !query.includes('\n') && !query.includes('\r');
    if (caseSensitive || ascii) {
      const fold = !caseSensitive && /[A-Za-z]/.test(query);
      fastQueries.push({
        id: q.id,
        needle: fold ? Buffer.from(query.toLowerCase(), 'utf8') : Buffer.from(query, 'utf8'),
        fold,
      });
    } else {
      slowQueries.push(q);
    }
  }

  for (const rel of allowed) {
    if (opts.signal && opts.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    let buf;
    try { buf = readBuffer(path.join(root, rel)); } catch { continue; }
    if (buf == null || !buf.length) continue;
    scanned++;
    let folded = null;
    for (const fq of fastQueries) {
      const group = groups[fq.id];
      const hay = fq.fold ? (folded || (folded = asciiFoldBuffer(buf))) : buf;
      const result = scanLiteralBuffer(buf, hay, fq.needle, rel, limit - group.hits.length, true);
      for (const hit of result.hits) group.hits.push(hit);
      if (result.truncated) group.truncated = true;
    }
    if (slowQueries.length) {
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) assign(rel, i + 1, 1, lines[i], slowQueries);
    }
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
  ensureTrigramIndex,
  trigramCandidates,
  read,
  list,
  walk,
  cachePath,
  trigramPath,
  resetTrigramCache,
};
