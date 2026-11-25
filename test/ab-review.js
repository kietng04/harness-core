#!/usr/bin/env node
'use strict';

/*
 * Small A/B harness for the opt-in reviewer (plan 8.2): same fixture, same
 * replies except one reviewer turn, compare provider sends, prompt bytes and
 * wall time. One iteration per side plus p50 of two samples is intentionally
 * coarse so it runs offline in CI.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-review-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function runCase(label, review, iteration) {
  const work = path.join(root, label + '-' + iteration);
  fs.mkdirSync(work, { recursive: true });
  const replies = [
    'bash\n# note: write a file\necho ok > result.txt',
    'DONE\nfile written',
  ];
  if (review) replies.push('REVIEW\n{"verdict":"ok","revision":"{{revision}}"}');
  const repliesFile = path.join(root, label + '-replies-' + iteration + '.json');
  fs.writeFileSync(repliesFile, JSON.stringify(replies));
  const args = [
    '--mock', '--json', '--events', '--max-turns', '4',
    '--workdir', work, '--', 'write result.txt',
  ];
  if (review) args.splice(0, 0, '--review-required');
  const started = Date.now();
  const res = spawnSync(process.execPath, [AGENT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      HARNESS_HOME: home,
      HARNESS_MOCK_REPLIES: repliesFile,
      POLL_MS: '120',
      POST_GEN_GRACE_MS: '700',
      MAX_TURN_MS: '30000',
    },
  });
  const out = String(res.stdout || '') + '\n' + String(res.stderr || '');
  const resultMatch = String(res.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
  const result = resultMatch ? JSON.parse(resultMatch[1]) : null;
  const events = String(res.stdout || '').split('\n')
    .filter((line) => line.startsWith('__HARNESS_EVENT__'))
    .map((line) => {
      try { return JSON.parse(line.slice('__HARNESS_EVENT__'.length)); } catch { return null; }
    })
    .filter(Boolean);
  return {
    exit: res.status,
    result,
    out,
    sends: events.filter((e) => e.type === 'provider.waiting').length,
    reviewing: events.filter((e) => e.type === 'progress.phase' && e.payload && e.payload.phase === 'reviewing').length,
    wallMs: Date.now() - started,
  };
}

function p50(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const off = [runCase('off', false, 1), runCase('off', false, 2)];
const on = [runCase('on', true, 1), runCase('on', true, 2)];

for (const r of [...off, ...on]) check('exit ' + r.exit, r.exit, 0);

const offSends = off.map((r) => r.sends);
const onSends = on.map((r) => r.sends);
check('off sends', offSends.every((n) => n === offSends[0]), true);
check('review adds exactly one provider turn', onSends.every((n) => n === offSends[0] + 1), true);
check('off reviewer skipped', off.every((r) => r.result.review.status === 'skipped'), true);
check('on reviewer reviewed', on.every((r) => r.result.review.status === 'reviewed'), true);
check('on reviewing phase', on.every((r) => r.reviewing >= 1), true);

const rows = {
  off: {
    sendsP50: p50(offSends),
    bytesP50: p50(off.map((r) => r.result.metrics.promptBytes)),
    wallMsP50: p50(off.map((r) => r.wallMs)),
  },
  on: {
    sendsP50: p50(onSends),
    bytesP50: p50(on.map((r) => r.result.metrics.promptBytes)),
    wallMsP50: p50(on.map((r) => r.wallMs)),
  },
};
console.log('  A/B reviewer (2 samples/side):');
console.log('  ' + JSON.stringify(rows));
console.log('  extra sends=' + (rows.on.sendsP50 - rows.off.sendsP50)
  + ' extraBytes=' + (rows.on.bytesP50 - rows.off.bytesP50)
  + ' extraWallMs=' + (rows.on.wallMsP50 - rows.off.wallMsP50));

if (failures) {
  console.error('\nA/B FAILED: ' + failures + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('A/B OK - reviewer costs exactly one extra provider turn on the same fixture');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
