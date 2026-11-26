#!/usr/bin/env node
'use strict';

/*
 * BUG-01: submit must be confirmed before provider.waiting / reply wait.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-confirm-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });

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
function excludes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), false);
}

function runCase(name, env, args = [], goal = 'Create requested.txt') {
  const work = path.join(root, name);
  fs.mkdirSync(work, { recursive: true });
  const replies = path.join(root, name + '-replies.json');
  fs.writeFileSync(replies, JSON.stringify([
    'bash\n# note: create the requested file\necho ok > requested.txt',
    'DONE\nrequested.txt created',
  ]));
  const res = spawnSync(process.execPath, [
    AGENT, '--mock', '--json', '--events', '--max-turns', '4', '--workdir', work,
    ...args, '--', goal,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      HARNESS_HOME: home,
      HARNESS_MOCK_REPLIES: replies,
      SEND_CONFIRM_MS: '900',
      MAX_TURN_MS: '30000',
      POLL_MS: '120',
      POST_GEN_GRACE_MS: '700',
      ...env,
    },
  });
  const out = String(res.stdout || '') + '\n' + String(res.stderr || '');
  let result = null;
  const m = String(res.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
  if (m) { try { result = JSON.parse(m[1]); } catch {} }
  return { res, out, result, work };
}

// A. Send button hidden, first Enter ignored, retry accepted.
{
  const c = runCase('retry', {
    HARNESS_MOCK_HIDE_SEND: '1',
    HARNESS_MOCK_IGNORE_ENTER: 'first',
  });
  check('retry exit', c.res.status, 0);
  check('retry result', c.result && c.result.status, 'done');
  includes('retry confirmed user-turn', c.out, 'confirmation=user-turn');
  includes('retry submit retry log', c.out, 'retrying once');
  includes('retry provider waiting after', c.out, '"type":"provider.waiting"');
  check('retry file', fs.existsSync(path.join(c.work, 'requested.txt')), true);
  check('retry turns', c.result && c.result.turns, 1);
  excludes('retry no false warning', c.out, 'no sign the message was sent');
}

// B. All Enters ignored: no provider.waiting, no FORMAT nudge, no done.
{
  const c = runCase('unconfirmed', {
    HARNESS_MOCK_HIDE_SEND: '1',
    HARNESS_MOCK_IGNORE_ENTER: 'all',
    MAX_TURN_MS: '1200',
    SEND_CONFIRM_MS: '500',
  });
  check('unconfirmed exit', c.res.status, 3);
  check('unconfirmed status', c.result && c.result.status, 'partial');
  check('unconfirmed reason', c.result && c.result.reason, 'send_unconfirmed');
  check('unconfirmed canResume', c.result && c.result.canResume, true);
  check('unconfirmed turns', c.result && c.result.turns, 0);
  excludes('unconfirmed no provider.waiting', c.out, '"type":"provider.waiting"');
  excludes('unconfirmed no FORMAT nudge', c.out, 'FORMAT ERROR:');
  excludes('unconfirmed no nudge log', c.out, 'Nudging');
  excludes('unconfirmed no done', c.out, '=== GOAL COMPLETE ===');
  check('unconfirmed no file', fs.existsSync(path.join(c.work, 'requested.txt')), false);
  const session = JSON.parse(fs.readFileSync(path.join(c.work, '.harness', 'session.json'), 'utf8'));
  check('unconfirmed draft saved', session.pendingDraft.includes('Create requested.txt'), true);
  check('unconfirmed last submit', session.lastSubmit && session.lastSubmit.status, 'unconfirmed');
}

// C. Normal path: visible Send button confirms and still uses the same sends.
{
  const c = runCase('normal', {});
  check('normal exit', c.res.status, 0);
  check('normal status', c.result && c.result.status, 'done');
  includes('normal button submit', c.out, 'method=button:');
  includes('normal confirmation', c.out, 'confirmation=user-turn');
  check('normal turns', c.result && c.result.turns, 1);
}

// D. Chat has no Stop button and the user turn appears late.
{
  const c = runCase('late', {
    HARNESS_MOCK_HIDE_STOP: '1',
    HARNESS_MOCK_SEND_DELAY_MS: '350',
    SEND_CONFIRM_MS: '1800',
  });
  check('late exit', c.res.status, 0);
  check('late status', c.result && c.result.status, 'done');
  includes('late user-turn confirmation', c.out, 'confirmation=user-turn');
  check('late one user turn', (c.out.match(/confirmation=user-turn/g) || []).length, 2);
  check('late turns', c.result && c.result.turns, 1);
}

if (failures) {
  console.error('\nSEND CONFIRMATION FAILED: ' + failures + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('SEND CONFIRMATION OK - retry once, unconfirmed keeps draft/no waiting/no nudge, normal path');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
