#!/usr/bin/env node
'use strict';

/*
 * Section 7.3 PTY acceptance: the real Ink TUI at a wide window and 46x12,
 * with a long transcript, an open approval panel, PageUp scrolling, denial,
 * and the terminal result.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRIVER = path.join(__dirname, 'pty-tui.py');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-image-'));
const png = path.join(tmp, 'clipboard.png');
// 1x1 transparent PNG, enough for the paste plumbing test.
fs.writeFileSync(png, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function probe(cols, rows) {
  const res = spawnSync('python3', [DRIVER, String(cols), String(rows)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      NODE_BIN: process.execPath,
      NO_COLOR: '1',
      HARNESS_CLIPBOARD_IMAGE: png,
    },
  });
  let data = null;
  try { data = JSON.parse(String(res.stdout || '').trim()); } catch {}
  if (!data) {
    failures++;
    console.error('FAIL pty ' + cols + 'x' + rows + ': no JSON from driver (exit ' + res.status + ')');
    console.error(String(res.stdout || '').slice(-3000));
    console.error(String(res.stderr || '').slice(-3000));
    return null;
  }
  console.log('  PTY ' + cols + 'x' + rows + ': ready=' + data.ready
    + ' imagePaste=' + data.imagePaste
    + ' approval=' + data.approval
    + ' phase=' + data.phase
    + ' direction=' + data.directionPartial
    + ' milestone=' + data.milestone
    + ' scroll=' + data.scroll
    + ' result=' + data.result
    + ' maxLine=' + data.maxLine);
  return data;
}

const narrow = probe(46, 12);
if (narrow) {
  check('pty 46 ready', narrow.ready, true);
  check('pty 46 clipboard image', narrow.imagePaste, true);
  check('pty 46 approval panel', narrow.approval, true);
  check('pty 46 phase line', narrow.phase, true);
  check('pty 46 direction', narrow.directionPartial, true);
  check('pty 46 milestone', narrow.milestone, true);
  check('pty 46 pageup scroll', narrow.scroll, true);
  check('pty 46 post-scroll redraw', narrow.postScrollActivity, true);
  check('pty 46 terminal result', narrow.result, true);
  check('pty 46 line sanity', narrow.maxLine < 200, true);
}

const wide = probe(120, 40);
if (wide) {
  check('pty wide ready', wide.ready, true);
  check('pty wide clipboard image', wide.imagePaste, true);
  check('pty wide approval panel', wide.approval, true);
  check('pty wide phase line', wide.phase, true);
  check('pty wide direction', wide.directionPartial, true);
  check('pty wide milestone', wide.milestone, true);
  check('pty wide pageup scroll', wide.scroll, true);
  check('pty wide post-scroll redraw', wide.postScrollActivity, true);
  check('pty wide terminal result', wide.result, true);
  check('pty wide line sanity', wide.maxLine < 260, true);
}

if (failures) {
  console.error('\nPTY FAILED: ' + failures + ' assertion(s)');
  process.exitCode = 1;
} else {
  console.log('PTY OK - 46x12 and 120x40, Ctrl+V image paste, scrolling transcript, open approval panel, result');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
