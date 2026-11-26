'use strict';

/*
 * One-hop JS/TS call-hierarchy candidates without adding a compiler dependency.
 * This is deliberately a candidate layer: import/alias aware calls get higher
 * confidence, plain name matches are references, computed calls are unresolved.
 * A future LSP/tsc backend can replace `backend` while keeping the result shape.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const search = require('./repo-search');

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function',
  'typeof', 'new', 'await', 'yield', 'super', 'this', 'constructor', 'import', 'require']);

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text)).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function read(workspace, rel, cache) {
  if (cache.has(rel)) return cache.get(rel);
  let text = '';
  try { text = fs.readFileSync(path.join(workspace, rel), 'utf8'); } catch {}
  cache.set(rel, text);
  return text;
}

function resolveImport(workspace, fromRel, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(workspace, fromRel)), spec);
  const candidates = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.jsx',
    base + '.ts', base + '.tsx', path.join(base, 'index.js'), path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')];
  for (const c of candidates) {
    const rel = toPosix(path.relative(workspace, c));
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

function parseImports(workspace, rel, text, fileSet) {
  const imports = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+([\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) {
    const source = m[2] || m[4];
    const resolved = resolveImport(workspace, rel, source, fileSet);
    if (!resolved) continue;
    const names = [];
    const clause = m[1] || '';
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        if (!bits[0]) continue;
        names.push({ original: bits[0].trim(), alias: (bits[1] || bits[0]).trim() });
      }
    }
    const defaultName = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (defaultName && !defaultName.startsWith('*')) {
      names.push({ original: 'default', alias: defaultName });
    }
    imports.push({ source, resolved, names, raw: m[0] });
    if (m[3]) imports.push({ source, resolved, names: [{ original: '*', alias: m[3] }], raw: m[0] });
  }
  return imports;
}

function findDefinitions(workspace, files, symbol, cache) {
  const defs = [];
  const re = new RegExp('\\b(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+'
    + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  for (const rel of files) {
    if (!JS_EXT.has(path.extname(rel).toLowerCase())) continue;
    const text = read(workspace, rel, cache);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const col = lines[i].indexOf(symbol, m.index) + 1;
      defs.push({ path: rel, line: i + 1, column: col, text: lines[i].trim(), digest: sha256(text) });
    }
  }
  return defs;
}

function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function stripStrings(line) {
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' ');
}

function callHierarchy(workspace, args = {}) {
  const symbolArg = String(args.symbol || args.query || '').trim();
  const targetPath = args.path ? String(args.path).replace(/^\.\//, '') : '';
  const targetLine = Number(args.line) || 0;
  const scope = args.scope || ['.'];
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 12));
  const files = search.walk(workspace, scope, 12).map((f) => f.rel);
  const fileSet = new Set(files);
  const cache = new Map();
  let symbol = symbolArg;
  let exact = null;

  if (targetPath) {
    if (!fileSet.has(targetPath)) return { ok: false, code: 'not_found', error: 'target path not in scope: ' + targetPath };
    const text = read(workspace, targetPath, cache);
    const line = (text.split('\n')[targetLine - 1] || '');
    const col = Number(args.column) || 0;
    if (!symbol) {
      const decl = line.match(/\b(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (decl) symbol = decl[1];
    }
    if (!symbol) {
      const re = /[A-Za-z_$][\w$]*/g;
      let best = '';
      for (const m of line.matchAll(re)) {
        if (!col || m.index + 1 >= col) { best = m[0]; break; }
      }
      symbol = best;
    }
    exact = { path: targetPath, line: targetLine || 1, column: col || line.indexOf(symbol) + 1, digest: sha256(text) };
  }
  if (!symbol) {
    return { ok: false, code: 'invalid_args', error: 'symbol or path:line:column is required' };
  }

  const definitions = findDefinitions(workspace, files, symbol, cache);
  if (!exact && !targetPath) {
    if (!definitions.length) {
      return {
        ok: true,
        data: {
          symbol, definitions: [], callers: [], callees: [], unresolved: [],
          coverage: { backend: 'regex-import-graph', semantic: false, reason: 'symbol definition not found' },
        },
      };
    }
    if (definitions.length > 1 && args.disambiguate !== false) {
      return {
        ok: true,
        data: {
          symbol,
          ambiguous: true,
          definitions: definitions.slice(0, 10),
          callers: [], callees: [],
          unresolved: definitions.map((d) => ({
            path: d.path, line: d.line, column: d.column,
            reason: 'ambiguous symbol: pass path, line, column to select one definition',
          })),
          coverage: { backend: 'regex-import-graph', semantic: false, filesScanned: files.length },
        },
      };
    }
    exact = definitions[0];
  }
  if (exact && !exact.digest) exact.digest = sha256(read(workspace, exact.path, cache));
  const selected = definitions.filter((d) => !exact || (d.path === exact.path && (!exact.line || d.line === exact.line)));

  const callers = [];
  const unresolved = [];
  for (const rel of files) {
    if (!JS_EXT.has(path.extname(rel).toLowerCase())) continue;
    const text = read(workspace, rel, cache);
    const lines = text.split('\n');
    const imports = parseImports(workspace, rel, text, fileSet);
    const targetImport = imports.find((imp) => selected.some((d) => d.path === imp.resolved));
    const aliases = new Set();
    if (targetImport) {
      for (const n of targetImport.names) {
        if (n.original === symbol || n.original === '*' || n.original === 'default') aliases.add(n.alias);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (isCommentLine(raw)) continue;
      const line = stripStrings(stripComments(raw));
      if (/\bimport\b|\brequire\s*\(/.test(line)) continue;
      if (selected.some((d) => d.path === rel && d.line === i + 1)) continue;
      const matchedAlias = [...aliases].find((a) => a && new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(line));
      const direct = new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(line);
      if (!matchedAlias && !direct && !new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(line)) {
        if (targetImport && /\]\s*\(/.test(line)) {
          unresolved.push({ path: rel, line: i + 1, column: 1, reason: 'computed call, cannot resolve statically' });
        }
        continue;
      }
      if (matchedAlias || direct) {
        const name = matchedAlias || symbol;
        const col = Math.max(1, line.indexOf(name) + 1);
        const resolved = !!targetImport || rel === exact.path;
        callers.push({
          path: rel,
          line: i + 1,
          column: col,
          symbol,
          kind: resolved ? 'call' : 'reference',
          confidence: targetImport ? 0.75 : (rel === exact.path ? 0.8 : 0.45),
          evidence: matchedAlias ? 'import alias: ' + matchedAlias : (rel === exact.path ? 'same-file call' : 'name match without resolved import'),
          revision: sha256(text),
          callText: stripComments(raw).trim().slice(0, 300),
        });
      } else {
        callers.push({
          path: rel,
          line: i + 1,
          column: Math.max(1, line.indexOf(symbol) + 1),
          symbol,
          kind: 'reference',
          confidence: 0.3,
          evidence: 'name reference outside a resolved import',
          revision: sha256(text),
          callText: stripComments(raw).trim().slice(0, 300),
        });
      }
      if (callers.length >= limit) break;
    }
    if (callers.length >= limit) break;
  }

  // One-hop callees from the selected definition body.
  const callees = [];
  for (const def of selected.slice(0, 2)) {
    const text = read(workspace, def.path, cache);
    const lines = text.split('\n');
    for (let i = def.line - 1; i < Math.min(lines.length, def.line + 80); i++) {
      const line = stripComments(lines[i] || '');
      for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (name === symbol || KEYWORDS.has(name)) continue;
        callees.push({
          path: def.path,
          line: i + 1,
          column: m.index + 1,
          symbol: name,
          kind: 'callee',
          confidence: 0.5,
          evidence: 'same-file call in definition body',
          revision: sha256(text),
        });
      }
    }
  }

  return {
    ok: true,
    data: {
      symbol,
      target: exact ? { path: exact.path, line: exact.line, column: exact.column, digest: exact.digest } : null,
      definitions: selected.slice(0, 5),
      callers: callers.slice(0, limit),
      callees: callees.slice(0, limit),
      unresolved: unresolved.slice(0, limit),
      coverage: {
        backend: 'regex-import-graph',
        semantic: false,
        language: 'js/ts',
        filesScanned: files.length,
        note: 'candidate call hierarchy; a local LSP/compiler backend can replace this layer',
      },
      revision: exact ? exact.digest : null,
      oneHop: true,
    },
  };
}

module.exports = { callHierarchy, parseImports, findDefinitions };
