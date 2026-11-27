#!/usr/bin/env node
'use strict';

/*
 * Fast Node scanner parity: byte-level literal scan, one hit per line,
 * matchCount, snippets, Unicode fallback, regex line semantics, limits.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const search = require('../repo-search');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-scan-'));
const text = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const lines = (rel) => text(rel).split('\n');

try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), [
    'const marker = "Needle_Token";',
    'const twice = "needle_token needle_token";',
    '// vi: ĐẶNG Needle_Token',
    'const tail = 1;',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'upper.txt'), 'ALPHA NEEDLE_TOKEN\n');
  fs.writeFileSync(path.join(root, 'src', 'multi.txt'), 'foo\nbar\n');
  fs.writeFileSync(path.join(root, 'src', 'crlf.txt'), 'alpha\r\nNeedle_Token\r\n');
  fs.writeFileSync(path.join(root, 'test', 'deep.js'), [
    'function before() {}',
    'const hit = "needle_token";',
    'function after() {}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'binary.bin'), 'needle_token\0binary');
  fs.writeFileSync(path.join(root, 'src', 'large.txt'), 'x'.repeat(600 * 1024) + ' needle_token');

  const args = { query: 'needle_token', match: 'literal', limit: 20, backend: 'node', instant: false };
  const result = search.search(root, args);
  check('literal ok', result.ok, true);
  check('literal backend', result.data.backend, 'node');
  check('literal hit lines', result.data.hits.length, 6);
  check('literal paths', [...new Set(result.data.hits.map((h) => h.path))].sort().join(','),
    'src/a.js,src/crlf.txt,src/upper.txt,test/deep.js');
  check('no duplicate line hits', result.data.hits.filter((h) => h.path === 'src/a.js').length, 3);

  const twice = result.data.hits.find((h) => h.path === 'src/a.js' && h.line === 2);
  check('matchCount line2', twice && twice.matchCount, 2);
  check('matchText line2', twice && twice.matchText, 'const twice = "needle_token needle_token";');
  check('snippet has prev+next', twice && twice.snippet,
    'const marker = "Needle_Token";\nconst twice = "needle_token needle_token";\n// vi: ĐẶNG Needle_Token');

  const viLine = lines('src/a.js')[2];
  const viHit = result.data.hits.find((h) => h.path === 'src/a.js' && h.line === 3);
  check('unicode column parity', viHit && viHit.column, viLine.indexOf('Needle_Token') + 1);

  const deep = result.data.hits.find((h) => h.path === 'test/deep.js');
  check('deep snippet', deep && deep.snippet,
    'function before() {}\nconst hit = "needle_token";\nfunction after() {}');

  const crlf = result.data.hits.find((h) => h.path === 'src/crlf.txt');
  check('crlf line', crlf && crlf.line, 2);
  check('crlf matchText', crlf && crlf.matchText, 'Needle_Token');

  const exact = search.search(root, { ...args, caseSensitive: true });
  check('case sensitive paths', exact.data.hits.map((h) => h.path + ':' + h.line).sort().join(','),
    'src/a.js:2,test/deep.js:2');

  const upper = search.search(root, { ...args, query: 'NEEDLE_TOKEN', caseSensitive: true });
  check('case sensitive upper', upper.data.hits.length, 1);
  check('case sensitive upper path', upper.data.hits[0].path, 'src/upper.txt');

  const unicode = search.search(root, { ...args, query: 'đặng', caseSensitive: false });
  check('unicode case-insensitive hit', unicode.data.hits.length, 1);
  check('unicode case-insensitive line', unicode.data.hits[0] && unicode.data.hits[0].line, 3);

  const regex = search.search(root, { query: 'Needle_Tok.n', match: 'regex', limit: 20, backend: 'node' });
  check('regex lines', regex.data.hits.length, 6);
  check('regex matchCount line2', regex.data.hits.find((h) => h.path === 'src/a.js' && h.line === 2).matchCount, 2);

  const crossLine = search.search(root, { query: 'foo[\\s\\S]*bar', match: 'regex', limit: 20, backend: 'node' });
  check('regex never spans lines', crossLine.data.hits.length, 0);

  const anchored = search.search(root, { query: '^const', match: 'regex', limit: 20, backend: 'node' });
  check('regex ^ per line', anchored.data.hits.length, 4);

  const limited = search.search(root, { ...args, limit: 2 });
  check('limit hits', limited.data.hits.length, 2);
  check('limit truncated', limited.data.truncated, true);

  const instant = search.search(root, { ...args, instant: true });
  check('instant ok', instant.ok, true);
  check('instant used index', instant.data.index && instant.data.index.used, true);
  const key = (r) => r.data.hits.map((h) => h.path + ':' + h.line + ':' + h.column).sort().join(',');
  check('instant matches scan', key(instant), key(result));

  const scoped = search.search(root, { ...args, instant: true, scope: ['test'] });
  check('instant scope', scoped.data.hits.every((h) => h.path.startsWith('test/')), true);
  check('instant scope hits', scoped.data.hits.length, 1);

  // Bloom index must never hide a hit: compare indexed vs full scan on a
  // deterministic random corpus, including case and Vietnamese variants.
  {
    const fuzz = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-scan-fuzz-'));
    try {
      let seed = 0x2545f491;
      const rand = () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 0x100000000;
      };
      const words = ['alpha', 'BETA', 'gamma', 'ĐẶNG', 'đặng', 'needle', 'Value', 'x+y [z]', 'restore'];
      fs.mkdirSync(path.join(fuzz, 'src'), { recursive: true });
      for (let f = 0; f < 24; f++) {
        const rows = [];
        for (let i = 0; i < 40; i++) {
          const parts = [];
          const n = 2 + Math.floor(rand() * 4);
          for (let j = 0; j < n; j++) parts.push(words[Math.floor(rand() * words.length)]);
          rows.push(parts.join(' '));
        }
        rows[20] = 'const rare' + (f % 8) + ' = "rareToken' + (f % 8) + '";';
        fs.writeFileSync(path.join(fuzz, 'src', 'f' + f + '.txt'), rows.join('\n'));
      }
      const key = (r) => r.data.hits.map((h) => h.path + ':' + h.line + ':' + h.column).sort().join(',');
      const rare = Array.from({ length: 8 }, (_, i) => 'rareToken' + i);
      const queries = [
        ...rare, ...rare.map((q) => q.toUpperCase()),
        'NEEDLE', 'beta', 'ĐẶNG', 'đặng', 'alp', 'lph', 'a y', 'ue',
      ];
      for (const query of queries) {
        for (const caseSensitive of [false, true]) {
          const base = { query, match: 'literal', limit: 20, caseSensitive };
          const full = search.search(fuzz, { ...base, instant: false });
          const idx = search.search(fuzz, { ...base, instant: true });
          if (!full.data.truncated && !idx.data.truncated) {
            check('fuzz indexed=' + query + '/' + caseSensitive, key(idx), key(full));
          }
          // No false negatives: every indexed hit exists in a scoped full scan.
          for (const hit of idx.data.hits) {
            const scopedHit = search.search(fuzz, { ...base, scope: [hit.path], instant: false });
            check('fuzz real hit=' + query + '/' + caseSensitive + '/' + hit.path + ':' + hit.line,
              key(scopedHit).includes(hit.path + ':' + hit.line + ':' + hit.column), true);
          }
        }
      }
    } finally {
      try { fs.rmSync(fuzz, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('  scanner fixture=' + result.data.hits.length + ' hits, scanned=' + result.data.scanned);
  if (failures) {
    console.error('\nFAST SCAN FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('FAST SCAN OK - byte literal, matchCount/snippet, Unicode, regex lines, limit, index parity');
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
