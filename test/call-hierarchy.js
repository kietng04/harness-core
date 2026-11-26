#!/usr/bin/env node
'use strict';

/*
 * One-hop JS call hierarchy candidates in repo.locate. No compiler dependency:
 * import/alias-aware calls are candidates; comments are ignored; computed
 * calls and ambiguous names stay unresolved with a reason.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../repo-tools');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-hierarchy-'));
try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), [
    'export function run(value) {',
    '  return helper(value);',
    '}',
    'function helper(value) { return value; }',
    'function unrelated() {',
    '  // falseCallee() is a comment',
    '  const s = "falseCallee() is a string";',
    '  return falseCallee();',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'b.js'), [
    'export function run(value) {',
    '  return other(value);',
    '}',
    'function other(value) { return value; }',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'same.js'), [
    "import { run } from './a';",
    'run(1);',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'alias.js'), [
    "import { run as runAlias } from './a';",
    'runAlias(2);',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'comment.js'), [
    "import { run } from './a';",
    '// run(3) is only a comment',
    'const note = "run(4) in a string";',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'dynamic.js'), [
    "import { run } from './a';",
    'const handlers = { run };',
    'handlers[key]();',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'other.js'), 'run(5);\n');
  fs.writeFileSync(path.join(root, 'src', 'b-caller.js'), [
    "import { run } from './b';",
    'run(6);',
  ].join('\n'));

  const ambiguous = tools.runTool(root, 'repo.locate', { symbol: 'run' });
  check('ambiguous flagged', ambiguous.data.ambiguous, true);
  check('ambiguous definitions', ambiguous.data.definitions.length >= 2, true);
  check('ambiguous callers withheld', ambiguous.data.callers.length, 0);
  check('ambiguous reason', ambiguous.data.unresolved.some((u) => /ambiguous/.test(u.reason)), true);

  const exact = tools.runTool(root, 'repo.locate', { symbol: 'run', path: 'src/a.js', line: 1, column: 17 });
  check('exact ok', exact.ok, true);
  check('exact target', exact.data.target && exact.data.target.path, 'src/a.js');
  const calls = exact.data.callers.filter((c) => c.kind === 'call');
  check('same-file/import callers', calls.some((c) => c.path === 'src/same.js'), true);
  check('alias caller', calls.some((c) => c.path === 'src/alias.js'), true);
  check('other definition caller isolated', calls.some((c) => c.path === 'src/b-caller.js'), false);
  check('comment ignored', exact.data.callers.some((c) => c.path === 'src/comment.js'), false);
  check('unresolved reference kept', exact.data.callers.some((c) => c.path === 'src/other.js' && c.kind === 'reference'), true);
  check('dynamic unresolved', exact.data.unresolved.some((u) => u.path === 'src/dynamic.js'), true);
  check('callee helper', exact.data.callees.some((c) => c.symbol === 'helper'), true);
  check('adjacent callee excluded', exact.data.callees.some((c) => c.symbol === 'falseCallee'), false);
  check('callee scope reported', exact.data.coverage.calleeScope.some((c) => c.scope === 'brace-matched'), true);
  check('semantic false', exact.data.coverage.semantic, false);
  check('backend coverage', exact.data.coverage.backend, 'regex-import-graph');
  check('revision present', /^sha256:/.test(exact.data.revision || ''), true);

  const byPath = tools.runTool(root, 'repo.locate', { path: 'src/b.js', line: 1 });
  check('path-derived symbol', byPath.data.target && byPath.data.target.path, 'src/b.js');
  check('b caller', byPath.data.callers.some((c) => c.path === 'src/b-caller.js' && c.kind === 'call'), true);

  if (failures) {
    console.error('\nCALL HIERARCHY FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('CALL HIERARCHY OK - ambiguity, path:line selection, aliases, comments, unresolved, callees');
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
