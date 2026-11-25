#!/usr/bin/env node
'use strict';

/*
 * PR 1 regression suite: verifier, resume, per-invocation budget, action
 * checkpoints, migration and MCP/TUI result parity.
 *
 * Every E2E case uses a temp workspace plus the scripted mock Copilot, so it
 * never touches the user's live Edge session or ~/.copilot-harness.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');
const TUI = path.join(ROOT, 'tui.mjs');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function checkIncludes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), true);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-reg-'));
const home = path.join(root, 'home');
const outside = path.join(root, 'outside');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const checkFilter = path.join(outside, 'check-filter.js');
fs.writeFileSync(checkFilter, [
  "'use strict';",
  "const fs = require('fs');",
  "const src = fs.readFileSync('filter.js', 'utf8');",
  "console.log('filter.js bytes=' + src.length);",
  "process.exit(/GOOD/.test(src) ? 0 : 1);",
].join('\n'));

const checkMutate = path.join(outside, 'check-mutate.js');
fs.writeFileSync(checkMutate, [
  "'use strict';",
  "const fs = require('fs');",
  "fs.appendFileSync('filter.js', '\\n// changed while verifying\\n');",
  "process.exit(0);",
].join('\n'));

const checkSlow = path.join(outside, 'check-slow.js');
fs.writeFileSync(checkSlow, [
  "'use strict';",
  'setTimeout(() => process.exit(0), 5000);',
].join('\n'));

function manifest(name, checks, inputPaths = ['filter.js']) {
  const file = path.join(outside, name);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    inputPaths,
    checks,
  }, null, 2));
  return file;
}

const manifestFail = manifest('manifest-fail.json', [
  { id: 'filter-empty', command: process.execPath, args: [checkFilter], timeoutMs: 5000 },
]);
const manifestChanged = manifest('manifest-changed.json', [
  { id: 'filter-empty', command: process.execPath, args: [checkFilter], timeoutMs: 6000 },
]);
const manifestStale = manifest('manifest-stale.json', [
  { id: 'mutate-input', command: process.execPath, args: [checkMutate], timeoutMs: 5000 },
  { id: 'slow-check', command: process.execPath, args: [checkSlow], timeoutMs: 150 },
]);

function workdir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'regression@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Regression'], { cwd: dir });
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
}

function replies(name, items, fallback) {
  const file = path.join(outside, name);
  fs.writeFileSync(file, JSON.stringify(items.map((x) => (typeof x === 'string' ? x : { reply: x }))));
  if (fallback != null) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.fallback = fallback;
    fs.writeFileSync(file, JSON.stringify(data));
  }
  return file;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [AGENT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      HARNESS_HOME: home,
      POLL_MS: '120',
      POST_GEN_GRACE_MS: '700',
      MAX_TURN_MS: '30000',
      MAX_TOTAL_MS: '120000',
      ...env,
    },
  });
}

function output(res) {
  return String(res.stdout || '') + '\n' + String(res.stderr || '');
}

function parseResult(res) {
  const m = String(res.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function session(work) {
  const file = path.join(work, '.harness', 'session.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function step(name, res, result) {
  const s = session(res.work);
  const actions = s && s.actions ? Object.keys(s.actions).length : 0;
  const v = result && result.verification;
  const missing = v && Array.isArray(v.checks)
    ? v.checks.filter((c) => c.status !== 'passed').map((c) => c.id + ':' + c.status).join(',')
    : '';
  console.log('  ' + name + ': exit=' + res.status
    + ' status=' + (result && result.status)
    + ' reason=' + (result && result.reason || '-')
    + ' turns=' + (s && s.turn)
    + ' actions=' + actions
    + (v ? ' verification=' + v.status + (missing ? ' missing=' + missing : '') : '')
    + (result && result.review && result.review.status !== 'skipped'
      ? ' review=' + result.review.status
        + (result.review.verdict ? ':' + result.review.verdict : '')
        + (result.review.attempts ? '#' + result.review.attempts : '')
      : ''));
}

function runCase(name, args, opts = {}) {
  const res = run(args, opts.env);
  res.work = opts.work;
  const result = parseResult(res);
  const markers = (String(res.stdout || '').match(/^__HARNESS_RESULT__/gm) || []).length;
  if (opts.print) {
    step(name, res, result);
    check(name + ' terminal result count', markers, 1);
  }
  if (opts.expect && failures === 0 && output(res).includes('FATAL')) {
    console.error(output(res).slice(-6000));
  }
  return { res, result, out: output(res), state: opts.work ? session(opts.work) : null };
}

/* ------------------------------------------------------------------ cases */

// 1. False DONE: the model says DONE while filter-empty fails. The engine must
//    run the manifest checker and keep a resumable partial checkpoint.
{
  const work = workdir('false-done');
  fs.writeFileSync(path.join(work, 'filter.js'), '// BAD\n');
  const repliesFile = replies('r-false-done.json', [
    'bash\n# note: write the broken implementation\necho "// BAD" > filter.js',
    'DONE\nfilter is implemented',
  ]);
  const { res, result, out, state } = runCase('false DONE', [
    '--mock', '--json', '--verify', manifestFail, '--review-required', '--max-turns', '1',
    '--workdir', work, '--', 'make filter-empty pass',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });

  check('false DONE exit', res.status, 3);
  check('false DONE status', result && result.status, 'partial');
  check('false DONE reason', result && result.reason, 'verification_failed');
  check('false DONE canResume', result && result.canResume, true);
  check('false DONE verifier status', result && result.verification && result.verification.status, 'failed');
  check('false DONE reviewer skipped', result && result.review && result.review.status, 'skipped');
  const failed = result && result.verification && result.verification.checks
    ? result.verification.checks.find((c) => c.id === 'filter-empty') : null;
  check('false DONE check id', failed && failed.id, 'filter-empty');
  check('false DONE check failed', failed && failed.status, 'failed');
  check('false DONE check exit', failed && failed.exitCode, 1);
  check('false DONE checkpoint done=false', state && state.done, false);
  check('false DONE checkpoint no doneAt', state && state.doneAt, undefined);
  check('false DONE action finished', state && state.actions && state.actions['1']
    && state.actions['1'].status, 'finished');
  checkIncludes('false DONE checker ran', out, 'filter.js bytes=');
}

// 2. Resume with a changed manifest must fail before the provider is touched.
{
  const work = path.join(root, 'false-done');
  const repliesFile = replies('r-changed.json', ['DONE\nshould not run']);
  const { res, result, out } = runCase('changed manifest', [
    '--continue', '--mock', '--json', '--verify', manifestChanged, '--max-turns', '1',
    '--workdir', work,
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });

  check('changed manifest exit', res.status, 1);
  check('changed manifest status', result && result.status, 'error');
  check('changed manifest code', result && result.code, 'verification_spec_changed');
  check('changed manifest no mock start', /MOCK: starting/.test(out), false);
}

// 3. Fix + resume: same session, same manifest, verifier passes, done. The
//    completed action must not be replayed.
{
  const work = path.join(root, 'false-done');
  fs.writeFileSync(path.join(work, 'filter.js'), '// GOOD\n');
  const repliesFile = replies('r-resume-pass.json', ['DONE\nfilter is fixed']);
  const { res, result, state } = runCase('fix + resume', [
    '--continue', '--mock', '--json', '--no-review', '--verify', manifestFail, '--max-turns', '2',
    '--workdir', work,
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });

  check('resume pass exit', res.status, 0);
  check('resume pass status', result && result.status, 'done');
  check('resume pass verifier', result && result.verification && result.verification.status, 'passed');
  check('resume pass checkpoint done', state && state.done, true);
  check('resume pass actions once', state && Object.keys(state.actions || {}).length, 1);
  check('resume pass history once', state && state.history.length, 1);
}

// 4. Same --max-turns on resume: A does action A then partial, B must be able
//    to run action B and finish with one final DONE turn.
{
  const work = workdir('same-cap');
  const repliesA = replies('r-cap-a.json', [
    'bash\n# note: action A\necho A > a.txt',
    'bash\n# note: action C must be refused\necho C > c.txt',
  ]);
  const a = runCase('same cap A', [
    '--mock', '--json', '--max-turns', '1', '--workdir', work, '--', 'same cap resume',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesA }, print: true });
  check('same cap A exit', a.res.status, 3);
  check('same cap A status', a.result && a.result.status, 'partial');
  check('same cap A ran A', fs.existsSync(path.join(work, 'a.txt')), true);
  check('same cap A no C', fs.existsSync(path.join(work, 'c.txt')), false);
  check('same cap A turns', a.state && a.state.turn, 1);

  const repliesB = replies('r-cap-b.json', [
    'bash\n# note: action B\necho B > b.txt',
    'DONE\nsame cap done',
  ]);
  fs.writeFileSync(path.join(work, 'filter.js'), '// GOOD\n');
  const b = runCase('same cap B', [
    '--continue', '--mock', '--json', '--verify', manifestFail, '--max-turns', '1', '--workdir', work,
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesB }, print: true });
  check('same cap B exit', b.res.status, 0);
  check('same cap B status', b.result && b.result.status, 'done');
  check('same cap B ran B', fs.existsSync(path.join(work, 'b.txt')), true);
  check('same cap B no C', fs.existsSync(path.join(work, 'c.txt')), false);
  check('same cap B turns', b.state && b.state.turn, 2);
  check('same cap B verifier', b.result && b.result.verification && b.result.verification.status, 'passed');
}

// 5. Interrupted action: a started checkpoint must stop for inspection with
//    zero replay and no mock/provider contact.
{
  const work = workdir('interrupted');
  fs.mkdirSync(path.join(work, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness', 'session.json'), JSON.stringify({
    schemaVersion: 4,
    goal: 'inspect interrupted action',
    turn: 2,
    status: 'partial',
    partial: true,
    done: false,
    history: [{ turn: 1, script: 'echo old', exit: 0, head: 'old' }],
    actions: {
      1: {
        id: 1,
        kind: 'bash',
        turn: 2,
        status: 'started',
        startedAt: Date.now() - 1000,
        script: 'echo replay > replay.txt',
      },
    },
  }, null, 2));
  const repliesFile = replies('r-interrupted.json', ['bash\necho replay > replay.txt']);
  const { res, result, out } = runCase('interrupted', [
    '--continue', '--mock', '--json', '--max-turns', '2', '--workdir', work,
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });

  check('interrupted exit', res.status, 2);
  check('interrupted status', result && result.status, 'blocked');
  check('interrupted reason', result && result.reason, 'resume_inspection_required');
  check('interrupted canResume', result && result.canResume, false);
  check('interrupted action id', result && result.inspection && result.inspection.actions[0].id, 1);
  check('interrupted no replay', fs.existsSync(path.join(work, 'replay.txt')), false);
  check('interrupted no mock start', /MOCK: starting/.test(out), false);
}

// 6. Checkpoint write failure before an action: zero spawn.
{
  const work = workdir('write-before-action');
  const repliesFile = replies('r-write-action.json', [
    'bash\n# note: must not spawn\necho hi > spawned.txt',
    'DONE\nnever',
  ]);
  const { res, result } = runCase('write before action', [
    '--mock', '--json', '--max-turns', '2', '--workdir', work, '--', 'write failure before action',
  ], {
    work,
    env: { HARNESS_MOCK_REPLIES: repliesFile, HARNESS_TEST_FAIL_SAVE: 'action_started' },
    print: true,
  });
  check('write before action exit', res.status, 1);
  check('write before action code', result && result.code, 'checkpoint_write_failed');
  check('write before action canResume', result && result.canResume, false);
  check('write before action no spawn', fs.existsSync(path.join(work, 'spawned.txt')), false);
}

// 7. Finalize write failure: no resume advertised and no done checkpoint.
{
  const work = workdir('write-finalize');
  const repliesFile = replies('r-write-finalize.json', ['DONE\nlooks done']);
  const { res, result, state } = runCase('write finalize', [
    '--mock', '--json', '--max-turns', '2', '--workdir', work, '--', 'finalize failure',
  ], {
    work,
    env: { HARNESS_MOCK_REPLIES: repliesFile, HARNESS_TEST_FAIL_SAVE: 'finalize' },
    print: true,
  });
  check('write finalize exit', res.status, 1);
  check('write finalize code', result && result.code, 'checkpoint_write_failed');
  check('write finalize canResume', result && result.canResume, false);
  check('write finalize done false', state && state.done, false);
}

// 7b. Checkpoint write failure before ATTACH: zero upload.
{
  const work = workdir('write-before-attach');
  fs.writeFileSync(path.join(work, 'note.txt'), 'hello');
  const repliesFile = replies('r-write-attach.json', [
    'ATTACH\n{"file":"note.txt"}',
    'DONE\nnever',
  ]);
  const { res, result, out } = runCase('write before attach', [
    '--mock', '--json', '--max-turns', '2', '--workdir', work, '--', 'attach write failure',
  ], {
    work,
    env: { HARNESS_MOCK_REPLIES: repliesFile, HARNESS_TEST_FAIL_SAVE: 'action_started' },
    print: true,
  });
  check('write before attach exit', res.status, 1);
  check('write before attach code', result && result.code, 'checkpoint_write_failed');
  check('write before attach no upload', /attached: note\.txt/.test(out), false);
  check('write before attach no action', Object.keys((session(work) && session(work).actions) || {}).length, 0);
}

// 8. Migration: done+partial resumes, a real done is already_done, corrupt
//    JSON has its own error, and a missing manifest is reported before spawn.
{
  const doneWork = workdir('migrate-done-partial');
  fs.mkdirSync(path.join(doneWork, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(doneWork, '.harness', 'session.json'), JSON.stringify({
    schemaVersion: 4,
    goal: 'legacy conflict',
    done: true,
    partial: true,
    turn: 3,
    history: [{ turn: 3, script: 'echo legacy', exit: 0, head: 'legacy' }],
    customField: 'keep-me',
  }, null, 2));
  const repliesFile = replies('r-migrate.json', ['DONE\nmigrated and fixed']);
  const migrated = runCase('migrate done+partial', [
    '--continue', '--mock', '--json', '--max-turns', '2', '--workdir', doneWork,
  ], { work: doneWork, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });
  check('migrate e2e exit', migrated.res.status, 0);
  check('migrate e2e status', migrated.result && migrated.result.status, 'done');
  check('migrate e2e keeps turn', migrated.state && migrated.state.turn, 3);
  check('migrate e2e keeps history', migrated.state && migrated.state.history.length, 1);
  check('migrate e2e keeps unknown', migrated.state && migrated.state.customField, 'keep-me');

  const realDoneWork = workdir('migrate-real-done');
  fs.mkdirSync(path.join(realDoneWork, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(realDoneWork, '.harness', 'session.json'), JSON.stringify({
    schemaVersion: 4, goal: 'already finished', done: true, status: 'done', doneAt: Date.now(),
  }, null, 2));
  const realDone = runCase('real done', [
    '--continue', '--mock', '--json', '--workdir', realDoneWork,
  ], { work: realDoneWork, print: true });
  check('real done exit', realDone.res.status, 1);
  check('real done code', realDone.result && realDone.result.code, 'already_done');
  check('real done no mock start', /MOCK: starting/.test(realDone.out), false);

  const corruptWork = workdir('corrupt-session');
  fs.mkdirSync(path.join(corruptWork, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(corruptWork, '.harness', 'session.json'), '{broken');
  const corrupt = runCase('corrupt session', [
    '--continue', '--mock', '--json', '--workdir', corruptWork,
  ], { work: corruptWork, print: true });
  check('corrupt exit', corrupt.res.status, 1);
  check('corrupt code', corrupt.result && corrupt.result.code, 'session_corrupt');

  const missingManifestWork = workdir('missing-manifest');
  fs.mkdirSync(path.join(missingManifestWork, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(missingManifestWork, '.harness', 'session.json'), JSON.stringify({
    schemaVersion: 4,
    goal: 'missing manifest',
    status: 'partial',
    partial: true,
    turn: 1,
    verification: {
      status: 'failed',
      specPath: path.join(outside, 'gone.json'),
      specHash: 'abc',
      workspace: missingManifestWork,
      checks: [],
    },
  }, null, 2));
  const missingManifest = runCase('missing manifest', [
    '--continue', '--mock', '--json', '--workdir', missingManifestWork,
  ], { work: missingManifestWork, print: true });
  check('missing manifest exit', missingManifest.res.status, 1);
  check('missing manifest code', missingManifest.result && missingManifest.result.code, 'verification_unavailable');
  check('missing manifest no mock start', /MOCK: starting/.test(missingManifest.out), false);
}

// 9. Stale evidence + check timeout: the input file changes while the checker
//    runs, so a passing check may not close the goal.
{
  const work = workdir('stale');
  fs.writeFileSync(path.join(work, 'filter.js'), '// GOOD\n');
  // Git fixture with a committed input; the checker leaves an uncommitted
  // change, so evidence must be rejected without relying on `git diff`.
  initGit(work);
  const repliesFile = replies('r-stale.json', [
    'DONE\nlooks good',
    'DONE\nstill looks good',
    'DONE\nplease finish',
  ]);
  const { res, result } = runCase('stale evidence', [
    '--mock', '--json', '--verify', manifestStale, '--max-turns', '2',
    '--workdir', work, '--', 'stale evidence',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });
  check('stale exit', res.status, 3);
  check('stale status', result && result.status, 'partial');
  check('stale verifier', result && result.verification && result.verification.status, 'stale');
  const checks = (result && result.verification && result.verification.checks) || [];
  check('stale timed_out check', checks.some((c) => c.id === 'slow-check' && c.status === 'timed_out'), true);
  check('stale passed check', checks.some((c) => c.id === 'mutate-input' && c.status === 'passed'), true);
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout;
  checkIncludes('stale git uncommitted change', dirty, 'filter.js');
}

// 9. Preview: the verifier must not start a subprocess and the action must not
//    run. The result stays unverified and resumable.
{
  const work = workdir('preview');
  const repliesFile = replies('r-preview.json', [
    'bash\n# note: preview must not spawn\necho hi > preview-spawn.txt',
    'DONE\npreview done',
  ]);
  const { res, result } = runCase('preview', [
    '--mock', '--json', '--preview', '--verify', manifestFail, '--max-turns', '1',
    '--workdir', work, '--', 'preview',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });
  check('preview exit', res.status, 3);
  check('preview status', result && result.status, 'partial');
  check('preview reason', result && result.reason, 'verification_unavailable');
  check('preview verifier', result && result.verification && result.verification.status, 'unavailable');
  check('preview no spawn', fs.existsSync(path.join(work, 'preview-spawn.txt')), false);
}

// 10. TUI result rendering: partial, missing check and /continue are visible
//     without a TTY.
{
  const tui = spawnSync(process.execPath, [TUI, '--print-result', JSON.stringify({
    status: 'partial',
    turns: 4,
    canResume: true,
    verification: {
      status: 'failed',
      checks: [{ id: 'filter-empty', status: 'failed', exitCode: 1 }],
    },
    review: { status: 'reviewed', verdict: 'findings', findings: [{ issue: 'edge case missing' }] },
  })], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  check('tui print exit', tui.status, 0);
  checkIncludes('tui partial label', tui.stdout, 'Chưa hoàn tất');
  checkIncludes('tui missing check', tui.stdout, 'filter-empty');
  checkIncludes('tui continue hint', tui.stdout, '/continue');
  checkIncludes('tui review findings', tui.stdout, 'edge case missing');

  const progressVerify = spawnSync(process.execPath, [TUI, '--print-progress', JSON.stringify({
    phase: { name: 'verifying' },
    verification: { passed: 1, total: 2, missing: ['resume-test'] },
    phaseElapsed: '3s',
  })], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  check('tui progress exit', progressVerify.status, 0);
  checkIncludes('tui progress phase', progressVerify.stdout, 'Đang xác minh');
  checkIncludes('tui progress counts', progressVerify.stdout, '1/2 check đạt');
  checkIncludes('tui progress missing', progressVerify.stdout, 'resume-test');

  const progressWait = spawnSync(process.execPath, [TUI, '--print-progress', JSON.stringify({
    phase: { name: 'waiting' },
    direction: 'Inspect checkpoint path',
    phaseElapsed: '12s',
  })], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  checkIncludes('tui progress waiting', progressWait.stdout, 'Đang chờ Copilot');
  checkIncludes('tui progress direction', progressWait.stdout, 'Inspect checkpoint path');
}

// 12. Opt-in reviewer: findings -> main fix -> re-verify new revision -> ok.
{
  const work = workdir('review-flow');
  fs.writeFileSync(path.join(work, 'filter.js'), '// BAD\n');
  const repliesFile = replies('r-review-flow.json', [
    'bash\n# note: implement filter\n# progress: {"milestone":"Implement filter"}\necho "// GOOD" > filter.js',
    'DONE\nimplemented',
    'REVIEW\n{"verdict":"findings","revision":"{{revision}}","findings":[{"issue":"empty input not covered","affectedCriteria":"filter-empty","evidence":"filter.js"}]}',
    'bash\n# note: cover empty input\n# progress: {"milestone":"Cover edge case","changeReason":"reviewer found a gap"}\necho "// GOOD edge" > filter.js',
    'DONE\nfixed edge case',
    'REVIEW\n{"verdict":"ok","revision":"{{revision}}"}',
  ]);
  const { res, result, out, state } = runCase('review flow', [
    '--mock', '--json', '--events', '--review-required', '--verify', manifestFail,
    '--max-turns', '6', '--workdir', work, '--', 'make filter pass with independent checks',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });

  check('review flow exit', res.status, 0);
  check('review flow status', result && result.status, 'done');
  check('review flow verification', result && result.verification && result.verification.status, 'passed');
  check('review flow reviewer', result && result.review && result.review.status, 'reviewed');
  check('review flow verdict', result && result.review && result.review.verdict, 'ok');
  check('review flow attempts', result && result.review && result.review.attempts, 2);
  check('review flow checked revisions', state && Object.keys(state.review.checkedRevisions || {}).length, 2);
  check('review flow fix round', state && state.review.fixRounds, 1);
  checkIncludes('review flow findings reached main', out, 'INDEPENDENT REVIEW FINDINGS');
  const reviewDir = path.join(home, 'runs', result.runId, 'review');
  const artifacts = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir) : [];
  check('review flow artifacts', artifacts.length, 2);
  if (artifacts.length) {
    const body = fs.readFileSync(path.join(reviewDir, artifacts[0]), 'utf8');
    checkIncludes('review artifact prompt', body, 'INDEPENDENT REVIEW');
    checkIncludes('review artifact revision', body, 'REVISION:');
  }
  const eventObjects = String(out).split('\n')
    .filter((line) => line.startsWith('__HARNESS_EVENT__'))
    .map((line) => {
      try { return JSON.parse(line.slice('__HARNESS_EVENT__'.length)); } catch { return null; }
    })
    .filter(Boolean);
  const eventTypes = eventObjects.map((e) => e.type);
  const phases = eventObjects
    .filter((e) => e.type === 'progress.phase')
    .map((e) => e.payload && e.payload.phase);
  check('review flow reviewing phases', phases.filter((p) => p === 'reviewing').length, 2);
  check('review flow review results', eventTypes.filter((t) => t === 'review.result').length, 2);
  const intents = eventObjects.filter((e) => e.type === 'progress.intent');
  check('review flow change reason', intents.some((e) => e.payload && e.payload.changeReason === 'reviewer found a gap'), true);
  check('review flow milestone', intents.some((e) => e.payload && e.payload.milestone === 'Cover edge case'), true);
}

// 13. Reviewer schema errors: required -> partial, optional -> keep verifier pass.
{
  const reqWork = workdir('review-invalid-required');
  fs.writeFileSync(path.join(reqWork, 'filter.js'), '// GOOD\n');
  const reqReplies = replies('r-review-invalid-req.json', ['DONE\nlooks good', 'REVIEW\nnot json']);
  const req = runCase('checker schema invalid required', [
    '--mock', '--json', '--review-required', '--verify', manifestFail,
    '--max-turns', '2', '--workdir', reqWork, '--', 'checker schema invalid required',
  ], { work: reqWork, env: { HARNESS_MOCK_REPLIES: reqReplies }, print: true });
  check('review invalid required exit', req.res.status, 3);
  check('review invalid required status', req.result && req.result.status, 'partial');
  check('review invalid required reason', req.result && req.result.reason, 'review_invalid');
  check('review invalid required reviewer', req.result && req.result.review && req.result.review.status, 'invalid');

  const optWork = workdir('review-invalid-optional');
  fs.writeFileSync(path.join(optWork, 'filter.js'), '// GOOD\n');
  const optReplies = replies('r-review-invalid-opt.json', [
    'DONE\nlooks good',
    'REVIEW\n{"verdict":"ok","revision":"deadbeef"}',
  ]);
  const opt = runCase('checker schema invalid optional', [
    '--mock', '--json', '--review', '--verify', manifestFail,
    '--max-turns', '2', '--workdir', optWork, '--', 'checker schema invalid optional',
  ], { work: optWork, env: { HARNESS_MOCK_REPLIES: optReplies }, print: true });
  check('review invalid optional exit', opt.res.status, 0);
  check('review invalid optional status', opt.result && opt.result.status, 'done');
  check('review invalid optional reviewer', opt.result && opt.result.review && opt.result.review.status, 'invalid');
}

// 13b. Reviewer budget: one review per revision and a hard invocation cap.
{
  const work = workdir('review-budget');
  fs.writeFileSync(path.join(work, 'filter.js'), '// BAD\n');
  const repliesFile = replies('r-review-budget.json', [
    'bash\n# note: implement filter\necho "// GOOD" > filter.js',
    'DONE\nimplemented',
    'REVIEW\n{"verdict":"findings","revision":"{{revision}}","findings":[{"issue":"edge case","evidence":"filter.js"}]}',
    'bash\n# note: fix edge case\necho "// GOOD edge" > filter.js',
    'DONE\nfixed',
  ]);
  const { res, result, state } = runCase('review budget', [
    '--mock', '--json', '--review-required', '--verify', manifestFail,
    '--max-turns', '6', '--workdir', work, '--', 'make filter pass with checks',
  ], {
    work,
    env: { HARNESS_MOCK_REPLIES: repliesFile, REVIEW_MAX: '1' },
    print: true,
  });
  check('review budget exit', res.status, 3);
  check('review budget status', result && result.status, 'partial');
  check('review budget reason', result && result.reason, 'review_unavailable');
  check('review budget verifier', result && result.verification && result.verification.status, 'passed');
  check('review budget attempts', result && result.review && result.review.attempts, 2);
  check('review budget done false', state && state.done, false);
}

// 14. Skills are listed in every prompt without an extra provider turn, and
//     only the selected skill content is loaded.
{
  const work = workdir('skills');
  fs.mkdirSync(path.join(work, '.cursor', 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(work, '.cursor', 'skills', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(work, '.cursor', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\n---\nALPHA SKILL BODY\n');
  fs.writeFileSync(path.join(work, '.cursor', 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\n---\nBETA SKILL BODY\n');

  const prompt = run(['--prompt', '--workdir', work, '--', 'use alpha to inspect the repo']);
  check('skills prompt exit', prompt.status, 0);
  checkIncludes('skills prompt list', prompt.stdout, 'AVAILABLE SKILLS');
  check('skills listed once', (prompt.stdout.match(/AVAILABLE SKILLS/g) || []).length, 1);
  checkIncludes('skills alpha name', prompt.stdout, '- alpha');
  checkIncludes('skills alpha content', prompt.stdout, 'ALPHA SKILL BODY');
  check('skills beta content absent', prompt.stdout.includes('BETA SKILL BODY'), false);
  check('skills no provider', /MOCK: starting/.test(output(prompt)), false);

  const empty = workdir('skills-empty');
  const none = run(['--prompt', '--workdir', empty, '--', 'no skills here']);
  checkIncludes('skills none', none.stdout, 'AVAILABLE SKILLS\n(none)');
}

// 12. Light default: one read action + DONE must use exactly two provider
//     sends, with no plan/progress/compact/review turn.
{
  const work = workdir('light-task');
  const repliesFile = replies('r-light.json', [
    'bash\n# note: read the workspace\npwd',
    'DONE\nread complete sends={{sends}}',
  ]);
  const { res, result, out } = runCase('light task', [
    '--mock', '--json', '--events', '--max-turns', '5', '--workdir', work, '--', 'read pwd then done',
  ], { work, env: { HARNESS_MOCK_REPLIES: repliesFile }, print: true });
  check('light task exit', res.status, 0);
  check('light task status', result && result.status, 'done');
  check('light task provider sends', /sends=2\b/.test(result && result.summary || ''), true);
  check('light task verification', result && result.verification && result.verification.status, 'unconfigured');
  check('light task reviewer skipped', result && result.review && result.review.status, 'skipped');

  const events = String(out).split('\n')
    .filter((line) => line.startsWith('__HARNESS_EVENT__'))
    .map((line) => {
      try { return JSON.parse(line.slice('__HARNESS_EVENT__'.length)); } catch { return null; }
    })
    .filter(Boolean);
  const types = events.map((e) => e.type);
  const iIntent = types.indexOf('progress.intent');
  const iStart = types.indexOf('action.started');
  const iVerify = types.indexOf('progress.verification');
  check('progress intent present', iIntent >= 0, true);
  check('progress order intent<start', iIntent < iStart, true);
  check('progress order start<verify', iStart < iVerify, true);
  const seqs = events.map((e) => e.seq);
  check('progress seq monotonic', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), true);
}

/* ----------------------------------------------------------------- report */

if (failures) {
  console.error('\nREGRESSION FAILED: ' + failures + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('REGRESSION OK - verifier, resume, budget, action checkpoint, MCP/TUI parity');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
