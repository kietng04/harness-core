#!/usr/bin/env node
'use strict';

/*
 * PR 2 instant grep: persistent trigram prefilter, incremental updates,
 * deletion/rename, scope filtering, case sensitivity and scan parity.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instant-grep-'));
try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), [
    'function restoreCheckpoint(session) {',
    '  return session.id;',
    '}',
    'const marker = "instant-grep-token";',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'noise.js'), Array.from({ length: 200 }, (_, i) => 'const n' + i + ' = ' + i + ';').join('\n'));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), '// instant-grep-token in a test\n');
  fs.writeFileSync(path.join(root, 'src', 'case.txt'), 'ALPHA only\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=instant-grep-token\n');
  fs.writeFileSync(path.join(root, 'src', 'big.txt'), 'x'.repeat(600 * 1024) + ' instant-grep-token');

  const first = search.search(root, { query: 'instant-grep-token', match: 'literal', limit: 10 });
  check('first ok', first.ok, true);
  check('index used', first.data.index && first.data.index.used, true);
  check('index files', first.data.index.files >= 4, true);
  check('hits exclude env', first.data.hits.some((h) => h.path === '.env'), false);
  check('hits include src', first.data.hits.some((h) => h.path === 'src/a.js'), true);
  check('hits include test', first.data.hits.some((h) => h.path === 'test/a.test.js'), true);
  check('big file skipped', first.data.hits.some((h) => h.path === 'src/big.txt'), false);

  // Parity with the Node full scan.
  const scan = search.search(root, {
    query: 'instant-grep-token', match: 'literal', limit: 10, backend: 'node', instant: false,
  });
  const key = (r) => r.data.hits.map((h) => h.path + ':' + h.line).sort().join(',');
  check('indexed=scan parity', key(first), key(scan));

  // Incremental add.
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'const fresh = "instant-grep-token-new";\n');
  const added = search.search(root, { query: 'instant-grep-token-new', match: 'literal', limit: 10 });
  check('incremental new hit', added.data.hits.some((h) => h.path === 'src/new.js'), true);
  check('incremental updated', added.data.index.updated >= 1, true);

  // Rename + delete.
  fs.renameSync(path.join(root, 'src', 'new.js'), path.join(root, 'src', 'renamed.js'));
  const renamed = search.search(root, { query: 'instant-grep-token-new', match: 'literal', limit: 10 });
  check('rename new path', renamed.data.hits.some((h) => h.path === 'src/renamed.js'), true);
  check('rename old path gone', renamed.data.hits.some((h) => h.path === 'src/new.js'), false);
  fs.rmSync(path.join(root, 'src', 'renamed.js'));
  const deleted = search.search(root, { query: 'instant-grep-token-new', match: 'literal', limit: 10 });
  check('deleted no hit', deleted.data.hits.length, 0);

  // Scope + case sensitivity + short query/regex fallback.
  const scoped = search.search(root, { query: 'instant-grep-token', match: 'literal', scope: ['test'], limit: 10 });
  check('scope only test', scoped.data.hits.every((h) => h.path.startsWith('test/')), true);
  const caseHit = search.search(root, { query: 'alpha', match: 'literal', caseSensitive: true, limit: 10 });
  check('case sensitive no hit', caseHit.data.hits.length, 0);
  const short = search.search(root, { query: 'AL', match: 'literal', limit: 10 });
  check('short query no index', !short.data.index || short.data.index.used !== true, true);
  const regex = search.search(root, { query: 'instant-grep-tok.n', match: 'regex', limit: 10 });
  check('regex no index', !regex.data.index || regex.data.index.used !== true, true);
  check('regex hit', regex.data.hits.length >= 1, true);

  // Corrupt cache must fall back, not fail.
  const cache = search.trigramPath(root);
  search.resetTrigramCache();
  fs.writeFileSync(cache, '{broken');
  const recovered = search.search(root, { query: 'instant-grep-token', match: 'literal', limit: 10 });
  check('corrupt cache fallback', recovered.ok, true);
  check('corrupt cache still hits', recovered.data.hits.length >= 1, true);

  // Cold/warm p50-ish local measurement.
  const times = [];
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    search.search(root, { query: 'instant-grep-token', match: 'literal', limit: 10 });
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const indexSize = fs.existsSync(search.trigramPath(root)) ? fs.statSync(search.trigramPath(root)).size : 0;
  check('index persisted', indexSize > 100, true);
  console.log('  instant grep p50=' + p50 + 'ms indexBytes=' + indexSize);

  if (failures) {
    console.error('\nINSTANT GREP FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('INSTANT GREP OK - trigram prefilter, parity, incremental add/rename/delete, scope, case, fallback');
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
