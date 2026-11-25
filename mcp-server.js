#!/usr/bin/env node
'use strict';

/**
 * mcp-server.js - expose the Edge Copilot harness to Codex (or any MCP client).
 *
 * Stdio MCP server, no dependencies:
 *   - copilot_run    : run a goal in the terminal harness (may take minutes)
 *   - copilot_status : report Edge/CDP/harness paths without touching the browser
 *
 * Codex config:
 *   [mcp_servers.copilot-edge]
 *   command = "/opt/homebrew/bin/node"
 *   args = ["/absolute/path/to/copilot-harness/mcp-server.js"]
 *   startup_timeout_sec = 30
 *   tool_timeout_sec = 3600
 *
 * Set COPILOT_HARNESS_MOCK=1 to route copilot_run to the local --mock test.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT = path.join(__dirname, 'agent.js');
const VERSION = '3.0.0';
const MAX_CAPTURE = 8 * 1024 * 1024;
const MAX_TOOL_MS = Number(process.env.COPILOT_TOOL_TIMEOUT_MS || 3600000);

function findEdge() {
  if (process.env.EDGE_BIN && fs.existsSync(process.env.EDGE_BIN)) return process.env.EDGE_BIN;
  const candidates = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function cdpInfo(timeoutMs = 1200) {
  const base = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { base, ok: false };
    const version = await res.json();
    let pages = [];
    try {
      const list = await fetch(base + '/json/list', { signal: AbortSignal.timeout(timeoutMs) });
      pages = await list.json();
    } catch {}
    return {
      base,
      ok: true,
      browser: version.Browser || null,
      copilotPages: pages
        .filter((p) => /copilot|m365\.cloud\.microsoft/i.test(String(p.url || '')))
        .map((p) => ({ title: p.title, url: p.url })),
    };
  } catch {
    return { base, ok: false };
  }
}

function home() {
  return process.env.HARNESS_HOME
    ? path.resolve(process.env.HARNESS_HOME)
    : path.join(os.homedir(), '.copilot-harness');
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function runAgent(args, cwd, timeoutMs, requestId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeRun.child = child;
    activeRun.requestId = requestId ?? null;

    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
    };

    child.stdout.on('data', (b) => { stdout = append(stdout, b); });
    child.stderr.on('data', (b) => { stderr = append(stderr, b); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, Math.max(5000, timeoutMs));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (activeRun.child === child) activeRun.child = null;
      resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (activeRun.child === child) activeRun.child = null;
      resolve({
        code: code == null ? 1 : code,
        stdout,
        stderr,
        timedOut,
        cancelled: signal === 'SIGINT' || signal === 'SIGTERM',
      });
    });
  });
}

function lastLines(text, n) {
  const lines = String(text || '').trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

function extractResult(stdout) {
  const match = String(stdout).match(/^__HARNESS_RESULT__(\{.*\})$/m);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function toolRun(args = {}, requestId) {
  const goal = String(args.goal || '').trim();
  if (!goal) throw new Error('goal is required');

  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error('cwd is not a directory: ' + cwd);
  }

  if (process.env.COPILOT_HARNESS_MOCK === '1') {
    const argv = ['--json', '--events', '--mock', '--yolo', '--workdir', cwd];
    if (args.maxTurns) {
      const n = Math.max(1, Math.min(200, Math.floor(Number(args.maxTurns) || 40)));
      argv.push('--max-turns', String(n));
    }
    argv.push('--', goal);
    return runAndFormat(argv, cwd, 'mock', requestId);
  }

  // v4 permission modes. Headless MCP has no approval channel, so the default
  // is preview (propose only). The caller must explicitly pass mode:'yolo'
  // (or configure trust) to let Copilot execute anything.
  const allowed = ['preview', 'ask', 'yolo', 'readonly'];
  const mode = allowed.includes(args.mode) ? args.mode : 'yolo';
  if (mode === 'ask') {
    return textResult('mode "ask" needs an interactive approval channel. '
      + 'Use mode:"preview" to only propose, mode:"yolo" to execute, or the TUI for per-action approval.', true);
  }
  const argv = ['--json', '--events', '--' + mode, '--workdir', cwd];
  if (args.noAttach) argv.push('--no-attach');
  if (args.review === true) argv.push('--review');
  if (args.reviewRequired === true) argv.push('--review-required');
  const turns = args.maxTurns
    ? Math.max(1, Math.min(200, Math.floor(Number(args.maxTurns) || 40)))
    : 40;
  argv.push('--max-turns', String(turns));
  argv.push('--', goal);
  return runAndFormat(argv, cwd, mode, requestId);
}

async function runAndFormat(argv, cwd, mode, requestId) {
  const started = Date.now();
  const res = await runAgent(argv, cwd, MAX_TOOL_MS, requestId);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  const result = extractResult(res.stdout);

  if (res.cancelled && !result) {
    return textResult('CANCELLED after ' + took + 's. Session state is in '
      + path.join(cwd, '.harness', 'session.json') + ' → /continue.', false);
  }

  if (res.timedOut) {
    return textResult('TIMEOUT after ' + took + 's (mode=' + mode + ').\n'
      + 'The agent process was stopped. Session state is in ' + path.join(cwd, '.harness', 'session.json') + '.', true);
  }

  if (!result) {
    return textResult('FAILED exit=' + res.code + ' (mode=' + mode + ', ' + took + 's)\n'
      + 'No __HARNESS_RESULT__ marker. Last output:\n'
      + lastLines(res.stdout || res.stderr, 80), true);
  }

  const expectedExit = {
    done: 0, partial: 3, blocked: 2, cancelled: 4, timed_out: 5, error: 1,
  }[result.status];
  if (expectedExit != null && result.exitCode != null && result.exitCode !== expectedExit) {
    return textResult('TRANSPORT ERROR: state/exit mismatch (status=' + result.status
      + ', marker exit=' + result.exitCode + ', expected=' + expectedExit + ').\n'
      + lastLines(res.stdout, 40), true);
  }
  if (expectedExit != null && res.code !== expectedExit) {
    return textResult('TRANSPORT ERROR: process exit=' + res.code + ' does not match status='
      + result.status + ' (expected ' + expectedExit + ').\n'
      + lastLines(res.stdout, 40), true);
  }

  if (result.status === 'error') {
    return textResult([
      'FAILED status=error exit=' + (result.exitCode == null ? res.code : result.exitCode) + ' (' + took + 's)',
      'code: ' + (result.code || 'unknown'),
      'error: ' + (result.message || result.reason || '(none)'),
      result.canResume ? 'canResume: true · /continue' : 'canResume: false',
      '',
      '--- last log lines ---',
      lastLines(res.stdout, 60),
    ].join('\n'), true);
  }

  const lines = [
    'status=' + result.status + ' exit=' + (result.exitCode == null ? res.code : result.exitCode)
      + ' turns=' + (result.turns == null ? '?' : result.turns)
      + ' (' + took + 's, mode=' + mode + ')',
    'workdir: ' + cwd,
    'run: ' + (result.runId || '(n/a)'),
  ];
  if (result.reason) lines.push('reason: ' + String(result.reason).split('\n')[0]);
  if (result.summary) lines.push('summary: ' + String(result.summary).split('\n').slice(0, 6).join('\n         '));
  if (result.canResume) lines.push('canResume: true · cwd/.harness/session.json → /continue');

  const verification = result.verification;
  if (verification && verification.status) {
    lines.push('verification: ' + verification.status
      + (verification.reason ? ' · ' + verification.reason : ''));
    const failed = (verification.checks || []).filter((c) => c.status !== 'passed');
    for (const c of failed) {
      lines.push('  - ' + c.id + ': ' + c.status
        + (c.exitCode != null ? ' (exit ' + c.exitCode + ')' : '')
        + (c.artifactRef ? ' · ' + c.artifactRef : ''));
    }
  }

  const review = result.review;
  if (review && review.status && review.status !== 'skipped') {
    lines.push('review: ' + review.status + (review.verdict ? ' · ' + review.verdict : '')
      + (review.evidenceRef ? ' · ' + review.evidenceRef : '')
      + (review.artifactRef ? ' · ' + review.artifactRef : ''));
    for (const f of (review.findings || []).slice(0, 6)) {
      lines.push('  - ' + f.issue);
    }
  }

  const metrics = result.metrics;
  if (metrics) {
    lines.push('metrics: sends=' + (metrics.sends || 0)
      + ' promptBytes=' + (metrics.promptBytes || 0)
      + ' execMs=' + (metrics.execMs || 0)
      + ' toolMs=' + (metrics.toolMs || 0)
      + ' verifyMs=' + (metrics.verifyMs || 0)
      + ' reviewMs=' + (metrics.reviewMs || 0));
  }

  if (Array.isArray(result.artifactPaths) && result.artifactPaths.length) {
    lines.push('artifacts: ' + result.artifactPaths.join(', '));
  }
  lines.push('', 'session: ' + path.join(cwd, '.harness', 'session.json'),
    'logs: ' + path.join(home(), 'session.log'),
    '', '--- last log lines ---', lastLines(res.stdout, 40));
  return textResult(lines.join('\n'), false);
}

async function toolStatus() {
  const info = await cdpInfo();
  const edge = findEdge();
  const profile = process.env.EDGE_PROFILE
    ? path.resolve(process.env.EDGE_PROFILE)
    : path.join(home(), 'edge-profile');
  const mockPath = path.join(__dirname, 'mock', 'copilot.html');

  const lines = [
    'harness: ' + __dirname,
    'agent: ' + AGENT,
    'node: ' + process.version,
    'platform: ' + process.platform + ' ' + process.arch,
    'edge: ' + (edge || 'NOT FOUND'),
    'edge profile: ' + profile,
    'cdp: ' + info.base + (info.ok ? ' (reachable)' : ' (not reachable)'),
    'browser: ' + (info.browser || '(unknown)'),
    'copilot pages: ' + (info.copilotPages ? info.copilotPages.length : 0),
    'mock: ' + (fs.existsSync(mockPath) ? 'available' : 'missing'),
    'mcp default mode: yolo (executes, deny list on); pass mode:"preview" to only propose',
    'mock env: ' + (process.env.COPILOT_HARNESS_MOCK === '1' ? 'on' : 'off'),
  ];
  if (info.copilotPages) {
    for (const p of info.copilotPages) lines.push('  - ' + p.url);
  }
  if (!info.ok) {
    lines.push('', 'Edge is not running with CDP. Start it with:');
    lines.push('  node ' + path.join(__dirname, 'agent.js') + ' --login');
  } else if (!info.copilotPages || info.copilotPages.length === 0) {
    lines.push('', 'CDP is up, but no Copilot page is open. The harness will open one.');
  }
  return textResult(lines.join('\n'));
}

const TOOLS = [
  {
    name: 'copilot_run',
    description: 'Run an autonomous coding goal through the user\'s Edge Copilot chat. '
      + 'Copilot proposes bash; the harness executes approved actions in cwd and sends output back. '
      + 'mode yolo (default) executes without per-action approval '
      + '(deny list still on); mode preview only proposes; mode readonly is engine-enforced read-only. Can take minutes.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The concrete task, with success criteria.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to the MCP server cwd.' },
        mode: { type: 'string', enum: ['preview', 'ask', 'yolo', 'readonly'], description: 'Permission mode. Default yolo (executes, deny list on).' },
        noAttach: { type: 'boolean', description: 'Disable file attachments from Copilot.' },
        review: { type: 'boolean', description: 'Opt in to one independent reviewer turn after verification.' },
        reviewRequired: { type: 'boolean', description: 'Require a valid reviewer result before done.' },
        maxTurns: { type: 'integer', minimum: 1, maximum: 200, description: 'Turn budget (default 40).' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'copilot_status',
    description: 'Report whether Edge CDP and the Copilot page are reachable, plus harness/profile paths. '
      + 'Call this before copilot_run when unsure.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const INSTRUCTIONS = [
  'Edge Copilot terminal harness.',
  'Call copilot_status first if Edge may not be running.',
  'copilot_run drives the user\'s Copilot chat; it can execute shell commands, so use readonly for reviews.',
  'If CDP is not reachable, ask the user to run: node agent.js --login (one-time Copilot sign-in).',
].join('\n');

let buffer = '';
let chain = Promise.resolve();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Active copilot_run child, so ping stays responsive and cancellation works.
const activeRun = { child: null, requestId: null };

function handleNotification(msg) {
  if (!msg || msg.method !== 'notifications/cancelled') return;
  const requestId = msg.params && (msg.params.requestId ?? msg.params.id);
  if (activeRun.child && (activeRun.requestId == null || String(activeRun.requestId) === String(requestId))) {
    const child = activeRun.child;
    activeRun.child = null;
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
  }
}

function handle(msg) {
  if (msg && msg.id == null) { handleNotification(msg); return; }
  if (!msg) return;
  const { id, method, params } = msg;

  // Liveness first: ping must answer even while a run is in flight.
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'copilot-edge-harness', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }

  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const run = name === 'copilot_run'
      ? toolRun(args, id)
      : name === 'copilot_status'
        ? toolStatus()
        : Promise.reject(new Error('Unknown tool: ' + name));

    return run
      .then((result) => send({ jsonrpc: '2.0', id, result }))
      .catch((err) => send({
        jsonrpc: '2.0',
        id,
        result: textResult('Tool error: ' + err.message, true),
      }));
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method },
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write('[copilot-mcp] invalid JSON line\n');
      continue;
    }
    chain = chain.then(() => handle(msg)).catch((e) => {
      process.stderr.write('[copilot-mcp] handler error: ' + e.message + '\n');
    });
  }
});

process.stdin.on('end', () => {
  // EOF: stop accepting work, reap the running child, then exit.
  if (activeRun.child) {
    const child = activeRun.child;
    activeRun.child = null;
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
  }
  chain.then(() => process.exit(0));
});

process.stderr.write('[copilot-mcp] ready (' + VERSION + ')\n');
