#!/usr/bin/env node
'use strict';

/*
 * PR4/PR5 local repo tools: tokenizer, BM25/exact search, read digest,
 * patch validation/journal, scope checks and one typed-tool agent E2E.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const search = require('../repo-search');
const tools = require('../repo-tools');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function includes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), true);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tools-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(work, 'src'), { recursive: true });
fs.writeFileSync(path.join(work, 'src', 'resume-state.js'), [
  'function resumeState(session) {',
  '  return loadCheckpoint(session.id);',
  '}',
  '',
  'module.exports = { resumeState };',
].join('\n'));
fs.writeFileSync(path.join(work, 'src', 'filter.js'), [
  'function filterEmpty(items) {',
  '  return items.filter(Boolean);',
  '}',
  'module.exports = { filterEmpty };',
].join('\n'));

// Tokenizer
const toks = search.tokenize('resumeState load_checkpoint snake-case khôi phục');
check('camel token', toks.includes('resumestate'), true);
check('camel split', toks.includes('resume') && toks.includes('state'), true);
check('snake token', toks.includes('load_checkpoint') && toks.includes('checkpoint'), true);
check('kebab token', toks.includes('snake') && toks.includes('case'), true);
check('vietnamese fold', toks.includes('khoi') && toks.includes('phuc'), true);

// Search exact, symbol, Vietnamese behavior.
const exact = tools.runTool(work, 'repo.search', { query: 'already_done', limit: 3 });
check('search exact ok', exact.ok, true);
const symbol = tools.runTool(work, 'repo.search', { query: 'resumeState', strategy: 'auto', limit: 5 });
check('search symbol hit', symbol.data.hits[0].path, 'src/resume-state.js');
includes('search symbol reason', symbol.data.hits[0].reason, 'symbol');
const vi = tools.runTool(work, 'repo.search', { query: 'khôi phục phiên', strategy: 'hybrid', limit: 5 });
check('search vietnamese hit', vi.data.hits[0].path, 'src/resume-state.js');
const noHits = tools.runTool(work, 'repo.search', { query: 'zzzz-not-in-repo', limit: 3 });
check('search no hits', noHits.data.hits.length, 0);

// Read range + digest + stale.
const read1 = tools.runTool(work, 'repo.read', { path: 'src/resume-state.js', from: 1, to: 3 });
check('read ok', read1.ok, true);
check('read range', read1.data.from + '-' + read1.data.to, '1-3');
includes('read digest', read1.data.digest, 'sha256:');
const stale = tools.runTool(work, 'repo.read', {
  path: 'src/resume-state.js', from: 1, to: 3, expectedDigest: 'sha256:deadbeef',
});
check('read stale digest', stale.code, 'stale_revision');
const outside = tools.runTool(work, 'repo.read', { path: '../outside.js' });
check('read outside', outside.code, 'out_of_scope');

// Patch: stale digest is zero-write; valid patch writes and journals.
const before = fs.readFileSync(path.join(work, 'src', 'filter.js'), 'utf8');
const stalePatch = tools.runTool(work, 'repo.apply_patch', {
  changes: [{
    path: 'src/filter.js',
    find: 'items.filter(Boolean)',
    replace: 'items.filter((x) => x != null)',
    expectedDigest: 'sha256:deadbeef',
  }],
}, 21);
check('patch stale code', stalePatch.code, 'stale_revision');
check('patch stale zero write', fs.readFileSync(path.join(work, 'src', 'filter.js'), 'utf8'), before);

const patch = tools.runTool(work, 'repo.apply_patch', {
  changes: [{
    path: 'src/filter.js',
    find: 'items.filter(Boolean)',
    replace: 'items.filter((x) => x != null)',
  }],
}, 22);
check('patch ok', patch.ok, true);
includes('patch journal', patch.data.journal, '.harness/journal/');
const after = fs.readFileSync(path.join(work, 'src', 'filter.js'), 'utf8');
check('patch applied', after.includes('x != null'), true);
check('patch cache invalidated', fs.existsSync(search.cachePath(work)), false);

const rollback = tools.runTool(work, 'repo.rollback', { journal: patch.data.journal }, 23);
check('rollback ok', rollback.ok, true);
check('rollback restored', fs.readFileSync(path.join(work, 'src', 'filter.js'), 'utf8'), before);
const secondRollback = tools.runTool(work, 'repo.rollback', { journal: patch.data.journal }, 24);
check('rollback stale guard', secondRollback.code, 'stale_revision');

// Batch read-only.
const batch = tools.runTool(work, 'tool.batch', {
  actions: [
    { tool: 'repo.read', args: { path: 'src/resume-state.js', from: 1, to: 2 } },
    { tool: 'repo.read', args: { path: 'src/filter.js', from: 1, to: 2 } },
  ],
});
check('batch ok', batch.ok, true);
check('batch results', batch.data.results.length, 2);

// p50 query latency on a warm index (coarse, local).
const times = [];
for (let i = 0; i < 8; i++) {
  const t = Date.now();
  tools.runTool(work, 'repo.search', { query: 'resume state', limit: 3 });
  times.push(Date.now() - t);
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length / 2)];
console.log('  search p50=' + p50 + 'ms (warm, fixture)');

// Agent E2E: typed search -> read -> patch -> DONE.
const replies = path.join(root, 'replies.json');
const toolRunDir = path.join(root, 'agent-work');
fs.cpSync(work, toolRunDir, { recursive: true });
fs.writeFileSync(path.join(toolRunDir, 'src', 'filter.js'), before);
fs.writeFileSync(replies, JSON.stringify([
  JSON.stringify({ version: 1, tool: 'repo.search', args: { query: 'resume session', strategy: 'hybrid', limit: 3 } }),
  JSON.stringify({ version: 1, tool: 'repo.read', args: { path: 'src/resume-state.js', from: 1, to: 3 } }),
  JSON.stringify({
    version: 1,
    tool: 'repo.apply_patch',
    args: { changes: [{ path: 'src/filter.js', find: 'items.filter(Boolean)', replace: 'items.filter((x) => x != null)' }] },
  }),
  'DONE\nfixed with typed tools',
]));
const e2e = spawnSync(process.execPath, [
  AGENT, '--mock', '--json', '--max-turns', '5', '--workdir', toolRunDir, '--', 'fix resume',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  env: {
    ...process.env,
    HARNESS_HOME: home,
    HARNESS_MOCK_REPLIES: replies,
    POLL_MS: '120',
    POST_GEN_GRACE_MS: '700',
    MAX_TURN_MS: '30000',
  },
});
const e2eOut = String(e2e.stdout || '') + '\n' + String(e2e.stderr || '');
check('agent tool exit', e2e.status, 0);
includes('agent tool search', e2eOut, 'tool: repo.search');
includes('agent tool read', e2eOut, 'tool: repo.read');
includes('agent tool patch', e2eOut, 'tool: repo.apply_patch');
check('agent tool patch applied', fs.readFileSync(path.join(toolRunDir, 'src', 'filter.js'), 'utf8').includes('x != null'), true);
const session = JSON.parse(fs.readFileSync(path.join(toolRunDir, '.harness', 'session.json'), 'utf8'));
check('agent tool actions', Object.values(session.actions).filter((a) => a.kind === 'tool').length, 3);
check('agent tool read coverage', JSON.stringify(session.reads['src/resume-state.js']), '[[1,3]]');
const resultMatch = String(e2e.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
const result = resultMatch ? JSON.parse(resultMatch[1]) : null;
check('agent tool done', result && result.status, 'done');

// Light default prompt: one-step goal stays bounded and still lists skills.
const light = spawnSync(process.execPath, [
  AGENT, '--prompt', '--workdir', work, '--', 'run pwd and echo ok',
], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
check('light prompt exit', light.status, 0);
check('light prompt bounded', Buffer.byteLength(light.stdout) < 1600, true);
check('light prompt skills once', (light.stdout.match(/AVAILABLE SKILLS/g) || []).length, 1);
includes('light prompt tools', light.stdout, 'repo.search');

if (failures) {
  console.error('\nREPO TOOLS FAILED: ' + failures + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('REPO TOOLS OK - tokenizer, BM25/exact search, read digest, patch journal, batch, typed agent E2E');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
