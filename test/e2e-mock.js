#!/usr/bin/env node
'use strict';

/*
 * End-to-end test with a real headless Edge and a fake Copilot page.
 * It exercises the same code path as production: CDP attach, composer,
 * streaming, code-block scraping, parsing, bash execution, attachment upload,
 * state persistence, and DONE.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-e2e-work-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-e2e-home-'));

try {
  const started = Date.now();
  const res = spawnSync(process.execPath, [
    AGENT,
    '--mock',
    '--yolo',
    '--json',
    '--workdir', work,
    '--max-turns', '8',
    'mock e2e',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    env: {
      ...process.env,
      HARNESS_HOME: home,
      POLL_MS: '200',
      POST_GEN_GRACE_MS: '1500',
      MAX_TURN_MS: '60000',
      MAX_TOTAL_MS: '180000',
    },
  });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  const out = (res.stdout || '') + '\n' + (res.stderr || '');

  check('exit code', res.status, 0);
  check('completed', /=== GOAL COMPLETE ===/.test(out), true);
  check('attached log', /attached: mock-output\.txt/.test(out), true);

  const match = String(res.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
  check('json marker', !!match, true);
  let result = null;
  if (match) {
    result = JSON.parse(match[1]);
    check('result status', result.status, 'done');
    check('result verification', result.verification && result.verification.status, 'unconfigured');
    check('summary attachment', /attachment=mock-output\.txt/.test(result.summary || ''), true);
  }

  const file = path.join(work, 'mock-output.txt');
  check('file exists', fs.existsSync(file), true);
  check('file contents', fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '', 'hello from mock');
  check('session saved', fs.existsSync(path.join(work, '.harness', 'session.json')), true);

  if (failures) {
    console.error('\n--- agent output ---');
    console.error(out.slice(-12000));
    process.exitCode = 1;
  } else {
    console.log('E2E OK (' + took + 's) - mock Copilot -> bash -> ATTACH -> DONE');
  }
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}
