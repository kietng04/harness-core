#!/usr/bin/env node
'use strict';

/*
 * Resume after send_unconfirmed + a manual Enter in the Copilot tab:
 * /continue must wait for the already-submitted reply, not send a new prompt.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');
const EDGE = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function runAgent(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('SKIP resume manual submit: Edge not found at ' + EDGE);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-manual-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const mock = pathToFileURL(path.join(ROOT, 'mock', 'copilot.html')).href;
  const replies = path.join(root, 'replies.json');
  fs.writeFileSync(replies, JSON.stringify([
    'DONE\nmanual reply accepted',
  ]));

  const port = await freePort();
  const profile = path.join(root, 'profile');
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1200,800', mock,
  ], { detached: true, stdio: 'ignore' });
  edge.unref();
  const cdp = 'http://127.0.0.1:' + port;
  let up = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(1000) });
      if (r.ok) { up = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  check('edge up', up, true);
  if (!up) {
    try { process.kill(-edge.pid, 'SIGKILL'); } catch {}
    return;
  }

  const env = {
    HARNESS_HOME: home,
    HARNESS_MOCK_CDP: cdp,
    HARNESS_MOCK_URL: mock,
    HARNESS_MOCK_REPLIES: replies,
    HARNESS_MOCK_HIDE_SEND: '1',
    HARNESS_MOCK_IGNORE_ENTER: 'all',
    SEND_CONFIRM_MS: '350',
    MAX_TURN_MS: '30000',
    POLL_MS: '120',
    POST_GEN_GRACE_MS: '700',
  };

  const first = await runAgent([
    '--mock', '--json', '--max-turns', '2', '--workdir', work, '--', 'Create requested.txt',
  ], env);
  check('first partial', first.code, 3);
  includes('first pending', first.stdout, 'send_unconfirmed');
  const sessionFile = path.join(work, '.harness', 'session.json');
  const session1 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  check('pending draft saved', session1.pendingDraft.includes('Create requested.txt'), true);

  // Simulate the user's manual Enter in the still-open tab.
  const browser = await chromium.connectOverCDP(cdp);
  try {
    let page = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (!p.url().startsWith('file:')) continue;
        const owner = await p.evaluate(() => { try { return sessionStorage.getItem('harness.workspace') || ''; } catch { return ''; } }).catch(() => '');
        if (owner === fs.realpathSync(work)) { page = p; break; }
      }
      if (page) break;
    }
    check('owned page found', !!page, true);
    if (!page) throw new Error('owned page not found');
    await page.evaluate(() => {
      window.__mockFlags = { ...(window.__mockFlags || {}), ignoreAllEnter: false };
    });
    await page.locator('[contenteditable="true"]').first().click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const turns = await page.evaluate(() => document.querySelectorAll('article.user').length);
    check('manual user turn', turns, 1);
    const draft = await page.evaluate(() => (document.querySelector('[contenteditable="true"]')?.innerText || '').trim());
    check('composer emptied after manual send', draft, '');
  } finally {
    await browser.close().catch(() => {});
  }

  const second = await runAgent([
    '--continue', '--mock', '--json', '--max-turns', '3', '--workdir', work,
  ], { ...env, HARNESS_MOCK_IGNORE_ENTER: '' });
  const out = String(second.stdout || '') + '\n' + String(second.stderr || '');
  if (second.code !== 0) console.error(out.slice(-5000));
  check('resume exit', second.code, 0);
  includes('resume manual detection', out, 'already submitted manually');
  excludes('resume no duplicate submit', out, 'SUBMIT: method=composer-enter confirmation=user-turn userTurns=1');
  const resultMatch = String(second.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
  const result = resultMatch ? JSON.parse(resultMatch[1]) : null;
  check('resume done', result && result.status, 'done');
  check('resume turns', result && result.turns, 0);

  // Inspect the tab: exactly one user turn, not two.
  const browser2 = await chromium.connectOverCDP(cdp);
  try {
    let page = null;
    for (const ctx of browser2.contexts()) {
      for (const p of ctx.pages()) {
        if (!p.url().startsWith('file:')) continue;
        const owner = await p.evaluate(() => { try { return sessionStorage.getItem('harness.workspace') || ''; } catch { return ''; } }).catch(() => '');
        if (owner === fs.realpathSync(work)) { page = p; break; }
      }
      if (page) break;
    }
    const turns = page ? await page.evaluate(() => document.querySelectorAll('article.user').length) : -1;
    check('exactly one user turn after resume', turns, 1);
  } finally {
    await browser2.close().catch(() => {});
  }

  try { process.kill(-edge.pid, 'SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

  if (failures) {
    console.error('\nRESUME MANUAL FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('RESUME MANUAL OK - /continue waited for the manual reply, one user turn');
  }
}

function includes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), true);
}
function excludes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), false);
}

main().catch((e) => {
  console.error('RESUME MANUAL ERROR: ' + e.stack);
  process.exitCode = 1;
});
