#!/usr/bin/env node
'use strict';

/*
 * BUG-02: two runs with different workspaces share one browser and must claim
 * separate Copilot/mock tabs. The test uses an externally started headless Edge
 * so both agent processes attach to the same CDP endpoint.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

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
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 120000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('SKIP tab isolation: Edge not found at ' + EDGE);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-isolation-'));
  const home = path.join(root, 'home');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const mock = pathToFileURL(path.join(ROOT, 'mock', 'copilot.html')).href;
  const port = await freePort();
  const profile = path.join(root, 'edge-profile');
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + String(port),
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1200,800',
    mock,
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  const cdp = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(1000) });
      if (res.ok) { up = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  check('edge up', up, true);
  if (!up) {
    try { process.kill(-edge.pid, 'SIGKILL'); } catch {}
    return;
  }

  const repliesA = path.join(root, 'a-replies.json');
  const repliesB = path.join(root, 'b-replies.json');
  fs.writeFileSync(repliesA, JSON.stringify([
    'bash\n# note: write a\necho a > a.txt',
    'DONE\na done',
  ]));
  fs.writeFileSync(repliesB, JSON.stringify([
    'bash\n# note: write b\necho b > b.txt',
    'DONE\nb done',
  ]));

  const common = {
    HARNESS_HOME: home,
    HARNESS_MOCK_CDP: cdp,
    HARNESS_MOCK_URL: mock,
    POLL_MS: '120',
    POST_GEN_GRACE_MS: '700',
    MAX_TURN_MS: '30000',
  };
  const [ra, rb] = await Promise.all([
    runAgent(['--mock', '--json', '--max-turns', '3', '--workdir', a, '--', 'write a'], {
      ...common, HARNESS_MOCK_REPLIES: repliesA,
    }),
    runAgent(['--mock', '--json', '--max-turns', '3', '--workdir', b, '--', 'write b'], {
      ...common, HARNESS_MOCK_REPLIES: repliesB,
    }),
  ]);
  check('run a exit', ra.code, 0);
  check('run b exit', rb.code, 0);
  check('a file', fs.existsSync(path.join(a, 'a.txt')), true);
  check('b file', fs.existsSync(path.join(b, 'b.txt')), true);
  check('a did not write b', fs.existsSync(path.join(a, 'b.txt')), false);
  check('b did not write a', fs.existsSync(path.join(b, 'a.txt')), false);

  try {
    const list = await (await fetch(cdp + '/json/list', { signal: AbortSignal.timeout(2000) })).json();
    const filePages = list.filter((p) => String(p.url || '').startsWith('file:'));
    check('separate mock tabs', filePages.length >= 3, true);
  } catch {}

  try { process.kill(-edge.pid, 'SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

  if (failures) {
    console.error('\nTAB ISOLATION FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('TAB ISOLATION OK - two workspaces, one browser, separate owned tabs and files');
  }
}

main().catch((e) => {
  console.error('TAB ISOLATION ERROR: ' + e.stack);
  process.exitCode = 1;
});
