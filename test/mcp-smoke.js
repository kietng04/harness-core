#!/usr/bin/env node
'use strict';

/*
 * MCP handshake + tools test. COPILOT_HARNESS_MOCK=1 routes copilot_run to the
 * local headless Edge mock, so this test covers the full Codex -> MCP -> agent
 * -> Edge -> bash loop without a Copilot login.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp-server.js');

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-work-'));
const workPartial = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-partial-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-home-'));

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    ...process.env,
    HARNESS_HOME: home,
    COPILOT_HARNESS_MOCK: '1',
    POLL_MS: '200',
    POST_GEN_GRACE_MS: '1500',
    MAX_TURN_MS: '60000',
    MAX_TOTAL_MS: '180000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => {});

const exited = new Promise((resolve) => {
  child.on('close', (code, signal) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP server exited (code=' + code + ', signal=' + signal + ')'));
    }
    pending.clear();
    resolve({ code, signal });
  });
});

function request(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout waiting for ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

(async () => {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'copilot-harness-test', version: '1.0.0' },
  });
  check('initialize server', init.result && init.result.serverInfo && init.result.serverInfo.name, 'copilot-edge-harness');
  notify('notifications/initialized', {});

  const list = await request('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name).sort();
  check('tool count', names.length, 2);
  check('copilot_run present', names.includes('copilot_run'), true);
  check('copilot_status present', names.includes('copilot_status'), true);

  const status = await request('tools/call', { name: 'copilot_status', arguments: {} });
  const statusText = status.result && status.result.content && status.result.content[0].text;
  checkIncludes('status harness', statusText, 'harness:');
  checkIncludes('status policy', statusText, 'mcp default mode: yolo');
  checkIncludes('status mock', statusText, 'mock env: on');

  const started = Date.now();
  const run = await request('tools/call', {
    name: 'copilot_run',
    arguments: { goal: 'mcp mock e2e', cwd: work, maxTurns: 8, mode: 'yolo' },
  }, 240000);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  const runText = run.result && run.result.content && run.result.content[0].text;
  check('run not error', !!(run.result && !run.result.isError), true);
  checkIncludes('run status', runText, 'status=done');
  checkIncludes('run attachment', runText, 'attachment=mock-output.txt');

  const file = path.join(work, 'mock-output.txt');
  check('run file exists', fs.existsSync(file), true);

  // Partial with exit 3 must keep status, reason, canResume and artifacts.
  // With maxTurns=1 the default mock's second reply is ATTACH, which the
  // final DONE/BLOCKED turn rejects -> partial.
  const partialStarted = Date.now();
  const partial = await request('tools/call', {
    name: 'copilot_run',
    arguments: { goal: 'mcp partial e2e', cwd: workPartial, maxTurns: 1, mode: 'yolo' },
  }, 240000);
  const partialTook = ((Date.now() - partialStarted) / 1000).toFixed(1);
  const partialText = partial.result && partial.result.content && partial.result.content[0].text;
  check('partial not tool error', !!(partial.result && !partial.result.isError), true);
  checkIncludes('partial status', partialText, 'status=partial');
  checkIncludes('partial exit', partialText, 'exit=3');
  checkIncludes('partial reason', partialText, 'reason: turn budget reached');
  checkIncludes('partial canResume', partialText, 'canResume: true');
  checkIncludes('partial artifacts', partialText, 'artifacts:');
  checkIncludes('partial session', partialText, path.join(workPartial, '.harness', 'session.json'));

  if (failures) {
    console.error('\n--- copilot_run result ---');
    console.error(String(runText).slice(-8000));
    console.error('\n--- copilot_run partial result ---');
    console.error(String(partialText).slice(-8000));
    process.exitCode = 1;
  } else {
    console.log('MCP OK (' + took + 's + ' + partialTook + 's) - initialize, tools/list, status, mock run, partial result');
  }

  child.stdin.end();
  const closed = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 10000)),
  ]);
  if (closed.code === 'timeout') {
    child.kill('SIGKILL');
    failures++;
    console.error('FAIL mcp server did not exit after stdin close');
    process.exitCode = 1;
  }
})().catch((err) => {
  failures++;
  console.error('FAIL ' + err.message);
  child.kill('SIGKILL');
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(workPartial, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});
