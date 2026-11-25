#!/usr/bin/env node
'use strict';

/**
 * agent.js - single-file Edge Copilot terminal harness (v3)
 *
 * The loop:
 *   1. Send a self-contained prompt to Edge Copilot over CDP.
 *   2. Copilot answers with exactly one fenced block: a bash script, DONE,
 *      BLOCKED, or ATTACH.
 *   3. Run the script in WORKDIR, capture stdout/stderr, feed the result back.
 *   4. Repeat until DONE/BLOCKED or a turn/time budget is hit.
 *
 * Usage:
 *   node agent.js "upgrade plugin foo and run tests"   (default mode: yolo)
 *   node agent.js --ask "goal"           approve each action (default)
 *   node agent.js --yolo "goal"          host unrestricted, no approvals
 *   node agent.js --preview "goal"       propose only, never execute
 *   node agent.js --readonly "goal"      engine-enforced read-only
 *   node agent.js --isolated "goal"      requires HARNESS_ISOLATED_BACKEND
 *   node agent.js --continue [file]      resume .harness/session.json (or file)
 *   node agent.js --per-run "goal"       fresh chat before every turn
 *   node agent.js --auto-compact 10 "goal"  handoff COMPACT -> new chat
 *   node agent.js --new-chat             compact handoff + new chat, then exit
 *   node agent.js --no-attach "goal"     disable the ATTACH protocol
 *   node agent.js --events               NDJSON control events on stdout
 *   node agent.js --probe                print selector counts on the live page
 *   node agent.js --login                launch Edge and wait for Copilot sign-in
 *   node agent.js --launch "goal"        launch Edge (debug profile) if needed
 *   node agent.js --mock                 end-to-end local mock (headless Edge)
 *   node agent.js --prompt "goal"        print the first prompt, no browser
 *   node agent.js --context              show repo instructions + memory + git
 *   node agent.js --selftest             pure unit tests, no browser
 *   node agent.js --json "goal"          machine-readable result for MCP/Codex
 *   node agent.js [opts] -- <goal>       everything after -- is the literal goal
 *
 * Requires:
 *   - Microsoft Edge (auto-detected; EDGE_BIN overrides)
 *   - npm install (playwright-core)
 *   - One-time Copilot sign-in in the harness Edge profile
 *
 * Design rules:
 *   - one bash script per turn, harness captures stdout/stderr
 *   - memory lives in .harness/PLAN.md + .harness/NOTES.md, re-read every turn
 *   - prompt is self-contained: survives Copilot silently truncating history
 *   - every turn has a deadline, every error has a class
 *   - repo instructions (AGENTS.md/CLAUDE.md) are loaded every turn, bounded
 *   - PLAN.md is a checkbox list; DONE is checked against it once
 *   - review goals get read-only prompting, read coverage, and an evidence gate
 *   - ATTACH lets Copilot upload a workdir file (image, log, diff) back into chat
 */

let chromium = null;
let playwrightError = null;
for (const mod of ['playwright-core', 'playwright']) {
  try {
    ({ chromium } = require(mod));
    playwrightError = null;
    break;
  } catch (e) {
    playwrightError = e;
  }
}

/*
 * Edge (signed-in work profiles in particular) can reject
 * Browser.setDownloadBehavior with "Browser context management is not
 * supported", which makes Playwright's connectOverCDP fail before we get a
 * browser handle. The harness never uses CDP downloads, so we intercept that
 * one command at the WebSocket layer and fake a success response. Disable with
 * HARNESS_PATCH_SETDOWNLOAD=0.
 */
let cdpPatchApplied = false;
function patchEdgeCDP() {
  if (cdpPatchApplied) return;
  cdpPatchApplied = true;
  if (process.env.HARNESS_PATCH_SETDOWNLOAD === '0') return;
  try {
    const candidates = [
      process.env.HARNESS_WS_BUNDLE,
      path.join(__dirname, 'node_modules', 'playwright-core', 'lib', 'utilsBundle.js'),
      path.join(__dirname, 'node_modules', 'playwright', 'node_modules', 'playwright-core', 'lib', 'utilsBundle.js'),
      path.join(__dirname, 'node_modules', 'playwright', 'lib', 'utilsBundle.js'),
    ].filter(Boolean);
    let WS = null;
    for (const p of candidates) {
      try {
        const mod = require(p);
        if (mod && mod.ws && mod.ws.prototype && mod.ws.prototype.send) { WS = mod.ws; break; }
      } catch {}
    }
    if (!WS) return;
    const origSend = WS.prototype.send;
    WS.prototype.send = function patchedSend(data, options, cb) {
      let msg = null;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch {}
      if (msg && msg.method === 'Browser.setDownloadBehavior') {
        const self = this;
        setImmediate(() => {
          const fake = JSON.stringify({ id: msg.id, result: {} });
          try { self.dispatchEvent(new MessageEvent('message', { data: fake })); }
          catch { try { self.emit('message', fake); } catch {} }
        });
        if (typeof cb === 'function') cb();
        return;
      }
      return origSend.call(this, data, options, cb);
    };
  } catch {}
}
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

/* ------------------------------------------------------------------ config */

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CFG = {
  cdp: process.env.CDP_URL || 'http://127.0.0.1:9222',
  chatUrl: process.env.CHAT_URL || 'https://copilot.cloud.microsoft/chat',
  home: process.env.HARNESS_HOME
    ? path.resolve(process.env.HARNESS_HOME)
    : path.join(os.homedir(), '.copilot-harness'),
  workdir: process.cwd(),
  sessionFile: null,
  profileDir: process.env.EDGE_PROFILE
    ? path.resolve(process.env.EDGE_PROFILE)
    : null, // filled below, after `home`
  edgeBin: process.env.EDGE_BIN || '',
  maxTurns: num('MAX_TURNS', 60),
  maxTurnMs: num('MAX_TURN_MS', 180000),
  maxTotalMs: num('MAX_TOTAL_MS', 3600000),
  scriptTimeoutMs: num('SCRIPT_TIMEOUT_MS', 300000),
  pollMs: num('POLL_MS', 400),
  stablePolls: 2,
  postGenGraceMs: num('POST_GEN_GRACE_MS', 8000),
  checkpointEvery: num('CHECKPOINT_EVERY', 8),
  resetAfterTurns: num('AUTO_COMPACT_TURNS', num('RESET_AFTER_TURNS', 10)),
  loginWaitMs: num('LOGIN_WAIT_MS', 300000),
  attachWaitMs: num('ATTACH_WAIT_MS', 1500),
  attachMaxBytes: num('ATTACH_MAX_BYTES', 10 * 1024 * 1024),
  maxObsHead: 25,
  maxObsTail: 45,
  maxObsChars: 5000,
  maxLiveLines: 80,
  maxPlanChars: 3000,
  maxNotesChars: 4500,
  maxCompactChars: num('COMPACT_MAX_CHARS', 4000),
  maxHighlights: 20,
  maxInstructionsChars: num('MAX_INSTRUCTIONS_CHARS', 4000),
  maxReadObsChars: num('MAX_READ_OBS_CHARS', 12000),
  maxReadObsHead: num('MAX_READ_OBS_HEAD', 140),
  maxReadObsTail: num('MAX_READ_OBS_TAIL', 20),
  maxScopeFiles: num('MAX_SCOPE_FILES', 120),
  maxScopeShown: num('MAX_SCOPE_SHOWN', 20),
  // v4: permission modes. 'ask' (approve each action) is the interactive
  // default; 'yolo' keeps the old behavior; 'preview' proposes but never
  // executes; 'readonly' denies writes; 'isolated' needs a real backend.
  mode: (process.env.HARNESS_MODE || 'yolo').toLowerCase(),
  lang: (process.env.HARNESS_LANG || 'vi').toLowerCase(),
  verifyPath: null,
  reviewMode: process.env.HARNESS_REVIEW === 'required' ? 'required'
    : ['1', 'true', 'yes', 'on'].includes(String(process.env.HARNESS_REVIEW || '').toLowerCase())
      ? 'optional' : 'off',
  reviewExplicit: false,
  reviewMax: num('REVIEW_MAX', 3),
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MS', 300000),
  lockTtlMs: num('LOCK_TTL_MS', 6 * 3600 * 1000),
  runId: null,
  seq: 0,
  terminalEmitted: false,
  events: false,
  cancelled: false,
  gitObserve: process.env.HARNESS_GIT !== '0',
  // Back-compat flags: HARNESS_SAFE=1/--safe used to mean "deny list on".
  // In v4 the deny list is always on; --safe/--ask now select approval mode.
  safeMode: true,
  // Runtime switches (set by CLI flags).
  readonly: false,
  perRun: false,
  noAttach: false,
  json: false,
  traceScripts: false,
  mock: false,
  launch: false,
  loginOnly: false,
};
CFG.profileDir = CFG.profileDir || path.join(CFG.home, 'edge-profile');

/* --------------------------------------------------------------- selectors */
/* Retune here when Copilot changes markup. Run --probe to check counts. */

const SEL = {
  composer: [
    '#m365-chat-editor-target-element',
    'span[contenteditable="true"][role="textbox"][aria-label="Message Copilot"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-label*="Message Copilot"]',
    '[data-copilot-initial-focus][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-testid="composer"]',
    '[data-testid="composer-input"]',
    'textarea[data-testid="composer-input"]',
    'textarea[aria-label*="Message"]',
    'textarea[placeholder*="Message"]',
    '#userInput',
    'textarea#userInput',
    'div[contenteditable="true"]',
    'span[contenteditable="true"]',
    'textarea',
  ],
  send: [
    'button[data-testid="send-button"]',
    'button[data-testid="send"]',
    'button[data-testid="submit-button"]',
    'button[aria-label="Send"]',
    'button[aria-label*="Send message"]',
    'button[aria-label*="Submit"]',
    'button[title="Send"]',
  ],
  stop: [
    'button[data-testid="stop-button"]',
    'button[data-testid="stop"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop responding"]',
    'button[aria-label*="Stop"]',
    'button[title="Stop generating"]',
    'button[title="Stop responding"]',
  ],
  code: [
    '[data-code-block="true"]',
    '[data-testid="code-block"] pre',
    '[aria-label="Code editor"]',
    'pre code',
    'pre',
  ],
  turn: [
    '[data-testid="conversation-turn"]',
    '[data-testid="copilot-message-div"]',
    '[data-testid="copilot-message-reply-div"]',
    '[data-testid="chat-message"]',
    '[data-testid="message"]',
    '[data-content="ai-message"]',
    '[data-testid="ai-message"]',
    '[role="article"]',
    'article',
  ],
  newChat: [
    'button[data-testid="new-chat"]',
    'button[aria-label="New chat"]',
    'button[aria-label*="New chat"]',
    'a[aria-label="New chat"]',
    '[title="New chat"]',
    'button:has-text("New chat")',
    'a:has-text("New chat")',
    '[role="button"]:has-text("New chat")',
  ],
  attach: [
    'button[aria-label*="Attach"]',
    'button[title*="Attach"]',
    'button[aria-label*="Upload"]',
    'button[title*="Upload"]',
    'button[data-testid*="attach"]',
    'button[data-testid*="upload"]',
    'button[aria-label="Add and manage sources"]',
    '[data-testid="PlusMenuButton"]',
    'label[for*="file"]',
  ],
  fileInput: 'input[type="file"]',
};

/* ------------------------------------------------------------------ errors */

class HarnessError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* ----------------------------------------------------------------- logging */

let logFilePath = null;

function log(...args) {
  const line = args.join(' ');
  process.stdout.write(line + '\n');
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, line + '\n'); } catch {}
  }
}

function ensureDirs() {
  fs.mkdirSync(CFG.home, { recursive: true });
  fs.mkdirSync(path.join(CFG.home, 'runs'), { recursive: true });
  logFilePath = path.join(CFG.home, 'session.log');
}

/* ------------------------------------------------ v4: run, events, approvals */

const EVENT_VERSION = 1;

function emitEvent(type, payload = {}) {
  if (!CFG.events || !CFG.runId) return;
  CFG.seq += 1;
  const line = '__HARNESS_EVENT__' + JSON.stringify({
    v: EVENT_VERSION,
    runId: CFG.runId,
    seq: CFG.seq,
    at: new Date().toISOString(),
    type,
    payload,
  });
  process.stdout.write(line + '\n');
}

function newRunId() {
  return 'run-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/* ------------------------------------------------------- progress channel */

function progressText(value, max = 180) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function scriptNote(script) {
  const m = String(script || '').match(/^\s*#\s*note\s*:\s*(.+)$/im);
  return m ? progressText(m[1], 160) : '';
}

function scriptProgressMeta(script) {
  const lines = String(script || '').split('\n').slice(0, 6);
  for (const line of lines) {
    const m = line.match(/^\s*#\s*progress\s*:\s*(\{.*\})\s*$/);
    if (!m) continue;
    try {
      const value = JSON.parse(m[1]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return {
        milestone: progressText(value.milestone, 160),
        changeReason: progressText(value.changeReason, 180),
      };
    } catch {}
  }
  return { milestone: '', changeReason: '' };
}

function emitPhase(phase, payload = {}) {
  if (!state) return;
  state.progress = (state.progress && typeof state.progress === 'object') ? state.progress : {};
  state.progress.phase = phase;
  state.progress.since = Date.now();
  emitEvent('progress.phase', {
    phase,
    turn: state.turn,
    milestone: state.progress.milestone || '',
    milestoneId: state.progress.milestoneId || '',
    ...payload,
  });
}

function emitIntent(intent, meta = {}, turn, actionId) {
  if (!state) return;
  const text = progressText(intent, 160);
  const milestone = progressText(meta.milestone, 160);
  const changeReason = progressText(meta.changeReason, 180);
  if (!text && !milestone && !changeReason) return;

  state.progress = (state.progress && typeof state.progress === 'object') ? state.progress : {};
  state.progress.milestones = Array.isArray(state.progress.milestones) ? state.progress.milestones : [];
  if (text) state.progress.direction = text;
  if (changeReason) {
    state.progress.changeReason = changeReason;
    state.progress.changeReasonAt = Date.now();
  }
  if (milestone) {
    state.progress.milestone = milestone;
    let entry = state.progress.milestones.find((m) => m.text === milestone);
    if (!entry) {
      entry = { id: 'm' + (state.progress.milestones.length + 1), text: milestone, at: Date.now() };
      state.progress.milestones.push(entry);
    }
    state.progress.milestoneId = entry.id;
  }
  state.progress.intentAt = Date.now();
  emitEvent('progress.intent', {
    intent: text,
    milestone,
    milestoneId: state.progress.milestoneId || '',
    changeReason,
    turn,
    actionId: actionId == null ? undefined : actionId,
  });
  saveState();
}

function emitVerificationProgress(ver) {
  if (!state || !ver) return;
  const checks = Array.isArray(ver.checks) ? ver.checks : [];
  const missing = checks.filter((c) => c.status !== 'passed').map((c) => c.id);
  const payload = {
    status: ver.status,
    revision: ver.revision || null,
    specHash: ver.specHash || null,
    total: checks.length,
    passed: checks.length - missing.length,
    missing,
    checks: checks.map((c) => ({
      id: c.id,
      status: c.status,
      exitCode: c.exitCode == null ? null : c.exitCode,
      artifactRef: c.artifactRef || null,
    })),
    reason: ver.reason || '',
  };
  state.progress = (state.progress && typeof state.progress === 'object') ? state.progress : {};
  state.progress.lastVerification = { ...payload, at: Date.now() };
  emitEvent('progress.verification', payload);
  saveState();
}

function runDir() {
  return path.join(CFG.home, 'runs', CFG.runId || 'adhoc');
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function acquireWorkspaceLock() {
  const dir = path.join(CFG.workdir, '.harness');
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, '.lock');
  const mine = {
    schemaVersion: 1,
    pid: process.pid,
    runId: CFG.runId,
    mode: CFG.mode,
    at: new Date().toISOString(),
  };
  try {
    const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const stale = !pidAlive(old.pid) || (Date.now() - Date.parse(old.at) > CFG.lockTtlMs);
    if (!stale) {
      throw new HarnessError('workspace_busy',
        'Another harness run owns this workspace (pid ' + old.pid + ', run ' + old.runId + ').');
    }
  } catch (e) {
    if (e.code === 'workspace_busy') throw e;
  }
  fs.writeFileSync(lockPath + '.tmp', JSON.stringify(mine) + '\n');
  fs.renameSync(lockPath + '.tmp', lockPath);
  return lockPath;
}

function releaseWorkspaceLock(lockPath) {
  if (!lockPath) return;
  try {
    const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AWS_|OPENAI_|ANTHROPIC_|GITHUB_|SMTP_)/i;

function childEnv() {
  if (CFG.mode === 'yolo') return { ...process.env, HARNESS: '1' };
  const env = { ...process.env, HARNESS: '1' };
  for (const name of Object.keys(env)) {
    if (SECRET_ENV_RE.test(name)) delete env[name];
  }
  return env;
}

const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,})/g;

function scrubSecrets(text) {
  return String(text || '').replace(SECRET_TEXT_RE, '[REDACTED]');
}

const READONLY_WRITE_RE = new RegExp([
  '(>>?)',
  '\\bsed\\s+-i', '\\brm\\b', '\\bmv\\b', '\\bcp\\b', '\\btee\\b',
  '\\bmkdir\\b', '\\btouch\\b', '\\bchmod\\b', '\\bchown\\b', '\\btruncate\\b',
  '\\bgit\\s+(add|commit|push|pull|merge|checkout|reset|clean|apply|stash|rebase)\\b',
  '\\bnpm\\s+(i|install|update|link|publish|ci)\\b',
  '\\bpip\\s+install\\b', '\\bpip3\\s+install\\b',
  '\\bcargo\\s+(build|install)\\b', '\\bgo\\s+(build|install|mod)\\b',
  '\\bmake\\b', '\\bdocker\\b', '\\bkubectl\\s+(apply|create|delete|edit)\\b',
].join('|'), 'm');

function readonlyViolation(script) {
  const m = String(script || '').match(READONLY_WRITE_RE);
  return m ? m[0] : '';
}

/* Approval: 'ask' waits on one stdin line. Accepted forms: JSON
 * {"approve":true|false} or plain y/a/n/x. Anything else or timeout = deny. */
function readApprovalLine(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch {}
      try { process.stdin.removeListener('data', onData); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const onData = (chunk) => {
      const line = chunk.toString('utf8').split(/\r?\n/)[0].trim();
      if (!line) return;
      finish(line);
    };
    try {
      process.stdin.resume();
      process.stdin.once('data', onData);
    } catch {
      finish('timeout');
    }
  });
}

function parseApproval(line) {
  const raw = String(line || '').trim();
  if (!raw || raw === 'timeout') return { approve: false, reason: 'timeout' };
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.approve === 'boolean') return { approve: obj.approve, reason: obj.reason || '' };
  } catch {}
  if (/^(y|a|yes|approve|duy)/i.test(raw)) return { approve: true };
  if (/^(n|x|no|deny|tu|khong)/i.test(raw)) return { approve: false, reason: 'denied' };
  return { approve: false, reason: 'unrecognized input' };
}

async function requestApproval(kind, payload, actionId) {
  const id = actionId || nextActionId();
  if (CFG.mode === 'yolo') return { approve: true, actionId: id };
  if (CFG.mode === 'preview') return { approve: false, actionId: id, reason: 'preview mode' };
  if (CFG.mode === 'readonly' && kind === 'bash') {
    const hit = readonlyViolation(payload.script);
    if (hit) return { approve: false, actionId: id, reason: 'read-only policy: ' + hit };
  }
  if (CFG.mode === 'isolated') {
    // Reached only with a configured backend; without one the run never starts.
    return { approve: true, actionId: id };
  }
  if (CFG.mode !== 'ask') return { approve: true, actionId: id };

  emitEvent('approval.requested', { actionId: id, kind, ...payload });
  emitPhase('approval', { kind, actionId: id });
  log('');
  log('CẦN DUYỆT · ' + (kind === 'bash' ? 'Chạy bash'
    : kind === 'verify' ? 'Chạy verification manifest' : 'Gửi file'));
  log('  Workspace: ' + CFG.workdir);
  if (kind === 'bash') {
    log('  Quyền:     shell trên máy, theo quyền user');
    const lines = String(payload.script || '').split('\n').slice(0, 12);
    for (const l of lines) log('  │ ' + l);
  } else if (kind === 'verify') {
    log('  Manifest:  ' + (payload.manifest || ''));
    log('  Checks:    ' + (payload.checks || []).join(', '));
  } else {
    log('  Quyền:     shell trên máy, theo quyền user');
    log('  File: ' + payload.file + ' (' + payload.bytes + ' bytes)');
  }
  log('  [a] duyệt lần này · [x] từ chối · chờ tối đa '
    + Math.round(CFG.approvalTimeoutMs / 1000) + 's');

  const line = await readApprovalLine(CFG.approvalTimeoutMs);
  const verdict = parseApproval(line);
  emitEvent(verdict.approve ? 'approval.granted' : 'approval.denied',
    { actionId: id, kind, reason: verdict.reason });
  return { ...verdict, actionId: id };
}

/* ------------------------------------------------------------------- state */

let state = null;
let currentChild = null;
let projectInstructions = '';
let projectCommands = '';

// Per-workdir by default, so --continue can never resume a goal from another
// repo. --session <file> (or --continue <file>) can override the path.
const SESSION_FILE = () => CFG.sessionFile || path.join(CFG.workdir, '.harness', 'session.json');

function newState(goal) {
  return {
    goal,
    startedAt: Date.now(),
    turn: 0,
    invocationStartTurn: 0,
    status: 'running',
    plan: '',
    notes: '',
    last: null,
    recent: [],
    nudges: 0,
    history: [],
    blocked: false,
    partial: false,
    doneNudged: false,
    mode: CFG.readonly ? 'review' : detectMode(goal),
    reads: {},
    readOrder: [],
    scope: [],
    reviewNudges: 0,
    actions: {},
    actionSeq: 0,
    verifyNudges: 0,
    verifyAttempts: 0,
    progress: {
      direction: '',
      phase: 'preparing',
      milestone: '',
      milestoneId: '',
      changeReason: '',
      milestones: [],
      lastVerification: null,
      since: Date.now(),
    },
    review: {
      status: 'skipped',
      attempts: 0,
      verdict: '',
      findings: [],
      revision: null,
      evidenceRef: null,
      checkedRevisions: {},
      at: null,
    },
    reviewMode: CFG.reviewMode,
  };
}

// The checkpoint is the resume contract. Callers that depend on durability
// pass a phase; a failed write then throws instead of silently continuing.
function saveState(phase) {
  if (!state) return false;
  if (phase && process.env.HARNESS_TEST_FAIL_SAVE === phase) {
    throw new HarnessError('checkpoint_write_failed',
      'simulated checkpoint write failure (' + phase + ')');
  }
  try {
    const file = SESSION_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    state.schemaVersion = state.schemaVersion || 4;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log('WARN: could not save state: ' + e.message);
    if (phase) {
      throw new HarnessError('checkpoint_write_failed',
        'could not write checkpoint (' + phase + '): ' + e.message);
    }
    return false;
  }
}

function loadState(strict = false) {
  const file = SESSION_FILE();
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (strict) throw new HarnessError('session_corrupt', 'Could not read session.json: ' + e.message);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (strict) throw new HarnessError('session_corrupt', 'session.json is not valid JSON: ' + e.message);
    return null;
  }
}

/* ------------------------------------------------------- canonical results */

const TERMINAL_EXIT = {
  done: 0,
  partial: 3,
  blocked: 2,
  cancelled: 4,
  timed_out: 5,
  error: 1,
};

function exitCodeForStatus(status) {
  return Object.prototype.hasOwnProperty.call(TERMINAL_EXIT, status) ? TERMINAL_EXIT[status] : 1;
}

function isTerminalStatus(status) {
  return Object.prototype.hasOwnProperty.call(TERMINAL_EXIT, status);
}

function startedActions(s) {
  const actions = (s && s.actions && typeof s.actions === 'object') ? s.actions : {};
  return Object.values(actions).filter((a) => a && a.status === 'started');
}

// Migrate old checkpoints in place. Unknown fields survive. `partial:true`
// wins over `done:true`: a failed DONE gate must stay resumable.
function migrateSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HarnessError('session_corrupt', 'session.json must contain an object.');
  }
  const s = raw;
  const from = Number(s.schemaVersion) || 3;
  const hadDone = s.done === true;
  const hadPartial = s.partial === true;

  if (hadDone && hadPartial) {
    s.done = false;
    delete s.doneAt;
    s.partial = true;
    s.migrated = { ...(s.migrated || {}), donePartialConflict: true, from };
    if (s.status === 'done') s.status = 'partial';
  }

  let status = s.status;
  if (!isTerminalStatus(status) && status !== 'running') {
    status = s.done ? 'done' : s.partial ? 'partial' : s.blocked ? 'blocked' : 'partial';
  }
  if (status === 'done' && s.partial === true) status = 'partial';

  if (status === 'done') {
    s.done = true;
    s.doneAt = s.doneAt || s.updatedAt || s.startedAt || Date.now();
    s.partial = false;
  } else {
    s.done = false;
    delete s.doneAt;
    if (status === 'partial') s.partial = true;
    if (status === 'blocked') s.blocked = true;
  }
  s.status = status;
  s.schemaVersion = Math.max(4, from);
  s.history = Array.isArray(s.history) ? s.history : [];
  s.recent = Array.isArray(s.recent) ? s.recent : [];
  s.actions = (s.actions && typeof s.actions === 'object') ? s.actions : {};
  if (!Number.isFinite(s.actionSeq)) {
    const ids = Object.keys(s.actions).map((k) => Number(k)).filter(Number.isFinite);
    s.actionSeq = ids.length ? Math.max(...ids) : 0;
  }
  s.progress = (s.progress && typeof s.progress === 'object') ? s.progress : {};
  s.progress.direction = typeof s.progress.direction === 'string' ? s.progress.direction : '';
  s.progress.milestone = typeof s.progress.milestone === 'string' ? s.progress.milestone : '';
  s.progress.milestoneId = typeof s.progress.milestoneId === 'string' ? s.progress.milestoneId : '';
  s.progress.changeReason = typeof s.progress.changeReason === 'string' ? s.progress.changeReason : '';
  s.progress.milestones = Array.isArray(s.progress.milestones) ? s.progress.milestones : [];
  s.progress.phase = 'preparing';
  s.review = (s.review && typeof s.review === 'object') ? s.review : {};
  s.review.status = s.review.status || 'skipped';
  s.review.attempts = Number(s.review.attempts) || 0;
  s.review.findings = Array.isArray(s.review.findings) ? s.review.findings : [];
  s.review.checkedRevisions = (s.review.checkedRevisions && typeof s.review.checkedRevisions === 'object')
    ? s.review.checkedRevisions : {};
  if (!['off', 'optional', 'required'].includes(s.reviewMode)) s.reviewMode = 'off';
  return s;
}

function terminalResult(status, fields = {}) {
  const known = isTerminalStatus(status) ? status : 'error';
  const canResume = fields.canResume === undefined
    ? ['partial', 'timed_out', 'blocked', 'cancelled'].includes(known)
    : fields.canResume === true;
  const verification = fields.verification
    || (state && state.verification)
    || { status: 'unconfigured', checks: [] };
  return {
    ...fields,
    status: known,
    exitCode: exitCodeForStatus(known),
    turns: fields.turns == null ? (state ? state.turn : 0) : fields.turns,
    canResume,
    verification,
    review: fields.review || (state && state.review) || { status: 'skipped', findings: [] },
    artifactPaths: Array.isArray(fields.artifactPaths) ? fields.artifactPaths : [runDir()],
  };
}

/* ------------------------------------------------------------- verifier v1 */

let verificationSpec = null;
let verificationApproved = false;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function fileDigest(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 'not-a-file';
    return sha256(fs.readFileSync(abs));
  } catch {
    return 'missing';
  }
}

// Checker binaries can be huge (node itself). Use a stat digest for tools;
// content digests are reserved for the declared workspace inputs.
function fileStatDigest(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 'not-a-file';
    return [st.size, Math.floor(st.mtimeMs), st.ino].join(':');
  } catch {
    return 'missing';
  }
}

function invalidVerify(message) {
  return new HarnessError('verification_invalid', message);
}

function loadVerificationSpec(file) {
  if (!file) return null;
  const absFile = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(absFile, 'utf8');
  } catch (e) {
    throw new HarnessError('verification_unavailable',
      'Cannot read --verify manifest ' + absFile + ': ' + e.message);
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    throw invalidVerify('--verify manifest is not valid JSON: ' + e.message);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw invalidVerify('--verify manifest must contain an object.');
  }
  if (spec.version !== 1) throw invalidVerify('--verify manifest version must be 1.');

  let workspace;
  try { workspace = fs.realpathSync(CFG.workdir); } catch (e) {
    throw new HarnessError('bad_workdir', 'Cannot resolve workspace: ' + e.message);
  }

  const inputPaths = Array.isArray(spec.inputPaths) ? spec.inputPaths : [];
  if (!inputPaths.length) throw invalidVerify('inputPaths must list at least one workspace file.');
  if (inputPaths.length > 200) throw invalidVerify('too many inputPaths (max 200).');
  const seenInputs = new Set();
  const normalizedInputs = [];
  for (const p of inputPaths) {
    if (typeof p !== 'string' || !p.trim()) throw invalidVerify('inputPaths entries must be non-empty strings.');
    if (path.isAbsolute(p)) throw invalidVerify('inputPaths must be relative to the workspace: ' + p);
    const rel = path.normalize(p);
    if (rel === '..' || rel.startsWith('..' + path.sep)) {
      throw invalidVerify('inputPath escapes the workspace: ' + p);
    }
    if (rel === '.harness' || rel.startsWith('.harness' + path.sep)) {
      throw invalidVerify('inputPaths must not include .harness: ' + p);
    }
    if (seenInputs.has(rel)) throw invalidVerify('duplicate inputPath: ' + rel);
    seenInputs.add(rel);
    const abs = path.resolve(workspace, rel);
    if (!isInside(workspace, abs)) throw invalidVerify('inputPath escapes the workspace: ' + p);
    let real = abs;
    try { real = fs.realpathSync(abs); } catch {}
    if (!isInside(workspace, real)) {
      throw invalidVerify('inputPath resolves outside the workspace: ' + p);
    }
    normalizedInputs.push(rel);
  }

  const checks = Array.isArray(spec.checks) ? spec.checks : [];
  if (!checks.length) throw invalidVerify('checks must not be empty.');
  if (checks.length > 20) throw invalidVerify('too many checks (max 20).');
  const ids = new Set();
  const normChecks = [];
  for (const c of checks) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw invalidVerify('each check must be an object.');
    const id = String(c.id || '').trim();
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw invalidVerify('check id must match [A-Za-z0-9._-]+: ' + JSON.stringify(c.id));
    }
    if (ids.has(id)) throw invalidVerify('duplicate check id: ' + id);
    ids.add(id);

    const command = String(c.command || '');
    if (!command || !path.isAbsolute(command)) {
      throw invalidVerify('check ' + id + ': command must be an absolute path.');
    }
    let st;
    try { st = fs.statSync(command); } catch {
      throw new HarnessError('verification_unavailable',
        'check ' + id + ': command not found: ' + command);
    }
    if (!st.isFile()) throw invalidVerify('check ' + id + ': command is not a file: ' + command);
    try { fs.accessSync(command, fs.constants.X_OK); } catch {
      throw new HarnessError('verification_unavailable',
        'check ' + id + ': command is not executable: ' + command);
    }

    if (c.args != null && !Array.isArray(c.args)) {
      throw invalidVerify('check ' + id + ': args must be an array.');
    }
    const args = (c.args || []).map((a) => String(a));
    const timeoutMs = c.timeoutMs == null ? 30000 : Number(c.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      throw invalidVerify('check ' + id + ': timeoutMs must be between 100 and 120000.');
    }
    normChecks.push({ id, command, args, timeoutMs: Math.floor(timeoutMs) });
  }

  const toolFiles = [];
  const addTool = (f) => {
    if (!f || !path.isAbsolute(f)) return;
    try { if (!fs.statSync(f).isFile()) return; } catch { return; }
    if (!toolFiles.includes(f)) toolFiles.push(f);
  };
  for (const c of normChecks) {
    addTool(c.command);
    for (const a of c.args) addTool(a);
  }

  return {
    path: absFile,
    hash: sha256(canonicalJson({ version: 1, inputPaths: normalizedInputs, checks: normChecks })
      + '\n' + toolFiles.map((f) => f + ':' + fileStatDigest(f)).join('\n')),
    workspace,
    inputPaths: normalizedInputs,
    checks: normChecks,
    toolFiles,
  };
}

function fingerprintVerification(spec) {
  const parts = [];
  for (const rel of spec.inputPaths) {
    parts.push('input:' + rel + ':' + fileDigest(path.resolve(spec.workspace, rel)));
  }
  for (const f of spec.toolFiles) parts.push('tool:' + f + ':' + fileStatDigest(f));
  return sha256(parts.join('\n'));
}

function resolveVerificationForState(saved) {
  const prev = saved && saved.verification && saved.verification.specPath
    ? saved.verification
    : null;
  if (CFG.verifyPath) {
    const spec = loadVerificationSpec(CFG.verifyPath);
    if (prev && prev.specHash && prev.specHash !== spec.hash) {
      throw new HarnessError('verification_spec_changed',
        'The --verify manifest changed since this session was checkpointed. '
        + 'Re-run with the original manifest or start a new goal.');
    }
    if (prev && prev.workspace && prev.workspace !== spec.workspace) {
      throw new HarnessError('verification_spec_changed',
        'The workspace changed since this session was checkpointed.');
    }
    verificationSpec = spec;
    return spec;
  }
  if (prev) {
    if (!fs.existsSync(prev.specPath)) {
      throw new HarnessError('verification_unavailable',
        'The verification manifest used by this session is missing: ' + prev.specPath
        + '. Pass --verify <file> to re-authorize it.');
    }
    const spec = loadVerificationSpec(prev.specPath);
    if (prev.specHash && prev.specHash !== spec.hash) {
      throw new HarnessError('verification_spec_changed',
        'The verification manifest changed since this session was checkpointed. '
        + 'Pass --verify <file> to re-authorize it.');
    }
    if (prev.workspace && prev.workspace !== spec.workspace) {
      throw new HarnessError('verification_spec_changed',
        'The workspace changed since this session was checkpointed.');
    }
    verificationSpec = spec;
    return spec;
  }
  verificationSpec = null;
  return null;
}

async function runVerificationCheck(check, attempt) {
  const started = Date.now();
  let timedOut = false;
  let result;
  try {
    result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(check.command, check.args, {
          cwd: CFG.workdir,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            HOME: process.env.HOME || os.homedir(),
            TMPDIR: os.tmpdir(),
            LANG: 'C',
            LC_ALL: 'C',
          },
        });
      } catch (e) {
        finish({ status: 'unavailable', exitCode: null, output: 'spawn failed: ' + e.message });
        return;
      }
      const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-8000);
      child.stdout.on('data', (b) => { stdout = append(stdout, b); });
      child.stderr.on('data', (b) => { stderr = append(stderr, b); });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, check.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        finish({ status: 'unavailable', exitCode: null, output: 'spawn error: ' + e.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        finish({
          status: timedOut ? 'timed_out' : (code === 0 ? 'passed' : 'failed'),
          exitCode: timedOut ? null : (code == null ? 1 : code),
          signal: signal || null,
          output: (stdout + '\n' + stderr).trim(),
        });
      });
    });
  } catch (e) {
    result = { status: 'unavailable', exitCode: null, output: e.message };
  }
  const durationMs = Date.now() - started;
  let artifactRef = null;
  try {
    const dir = path.join(runDir(), 'verify');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, check.id + '-' + String(attempt).padStart(3, '0') + '.txt');
    fs.writeFileSync(outPath, [
      '# check: ' + check.id,
      '# command: ' + check.command + (check.args.length ? ' ' + check.args.join(' ') : ''),
      '# status: ' + result.status,
      '# exit: ' + (result.exitCode == null ? '-' : result.exitCode),
      '# duration: ' + durationMs + 'ms',
      '',
      result.output || '',
    ].join('\n'));
    artifactRef = path.relative(runDir(), outPath).split(path.sep).join('/');
  } catch {}
  return {
    id: check.id,
    status: result.status,
    exitCode: result.exitCode,
    durationMs,
    signal: result.signal || null,
    output: clampTail(result.output || '', 2000),
    artifactRef,
  };
}

async function runVerification(spec) {
  if (!spec) {
    const unconfigured = { status: 'unconfigured', checks: [] };
    emitVerificationProgress(unconfigured);
    return unconfigured;
  }
  if (CFG.mode === 'preview') {
    const unavailable = {
      status: 'unavailable',
      reason: 'preview mode has zero subprocess; checks were not run',
      checks: [],
    };
    emitVerificationProgress(unavailable);
    return unavailable;
  }
  if (CFG.mode === 'ask' && !verificationApproved) {
    const approval = await requestApproval('verify', {
      checks: spec.checks.map((c) => c.id),
      manifest: spec.path,
    });
    if (!approval.approve) {
      const unavailable = {
        status: 'unavailable',
        reason: 'verification denied by user: ' + (approval.reason || 'no reason'),
        checks: [],
      };
      emitVerificationProgress(unavailable);
      return unavailable;
    }
    verificationApproved = true;
  }

  emitPhase('verifying', {
    checks: spec.checks.map((c) => c.id),
    specHash: spec.hash,
  });
  const before = fingerprintVerification(spec);
  state.verifyAttempts = (state.verifyAttempts || 0) + 1;
  const attempt = state.verifyAttempts;
  const checks = [];
  for (const check of spec.checks) checks.push(await runVerificationCheck(check, attempt));
  const after = fingerprintVerification(spec);

  let status;
  if (before !== after) status = 'stale';
  else if (checks.some((c) => c.status === 'unavailable')) status = 'unavailable';
  else if (checks.every((c) => c.status === 'passed')) status = 'passed';
  else status = 'failed';
  const ver = {
    status,
    checks,
    revision: after,
    specHash: spec.hash,
    at: Date.now(),
  };
  emitVerificationProgress(ver);
  return ver;
}

function recordVerification(ver) {
  state.verification = {
    status: ver.status,
    checks: ver.checks || [],
    revision: ver.revision || null,
    specHash: ver.specHash || (verificationSpec && verificationSpec.hash) || null,
    specPath: verificationSpec ? verificationSpec.path : null,
    workspace: verificationSpec ? verificationSpec.workspace : null,
    reason: ver.reason || '',
    at: Date.now(),
  };
  return state.verification;
}

function currentVerification() {
  if (state && state.verification && state.verification.status) return state.verification;
  if (verificationSpec) {
    return { status: 'unavailable', reason: 'verifier was not run', checks: [] };
  }
  return { status: 'unconfigured', checks: [] };
}

function verificationIssues(ver) {
  return (ver.checks || [])
    .filter((c) => c.status !== 'passed')
    .map((c) => {
      const out = String(c.output || '').split('\n').slice(-8).join('\n');
      return '- ' + c.id + ': ' + c.status
        + (c.exitCode != null ? ' (exit ' + c.exitCode + ')' : '')
        + (out ? '\n' + out : '');
    })
    .join('\n');
}

/* ------------------------------------------------------- independent review */

function reviewEvidence(ver) {
  const root = findProjectRoot();
  const parts = [];
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=3', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
      if (diff) parts.push('GIT DIFF:\n' + diff);
    } catch {}
  }
  if (!parts.length && verificationSpec) {
    for (const rel of verificationSpec.inputPaths) {
      const abs = path.resolve(CFG.workdir, rel);
      const content = readTextFileSafe(abs, 12000);
      parts.push('INPUT ' + rel + ':\n' + (content || '(missing)'));
    }
  }
  if (!parts.length && state.last) {
    parts.push('LAST OBSERVATION:\n' + formatObservation(state.last));
  }
  return clampMiddle(parts.join('\n\n') || '(no diff available)', 16000);
}

function buildReviewPrompt(ver) {
  const checks = (ver.checks || []).length
    ? ver.checks.map((c) => '- ' + c.id + ': ' + c.status
      + (c.exitCode != null ? ' (exit ' + c.exitCode + ')' : '')).join('\n')
    : '- (no manifest checks configured)';
  return [
    'INDEPENDENT REVIEW (read-only). Do not run commands, edit files, attach files, or request approval.',
    languageLine(),
    'GOAL: ' + state.goal,
    'REVISION: ' + (ver.revision || 'unconfigured'),
    'CHECK RESULTS:',
    checks,
    'DIFF OR DECLARED INPUTS:',
    reviewEvidence(ver),
    '',
    'Look for edge cases, regressions, and criteria the checks do not cover.',
    'Reply with exactly ONE fenced block. Open it with ```bash.',
    'First line INSIDE the block: REVIEW',
    'Then exactly one JSON object:',
    '{"verdict":"ok"|"findings","revision":"<copy REVISION>","evidenceRef":"short ref",'
      + '"findings":[{"issue":"...","affectedCriteria":"...","evidence":"..."}]}',
    'No prose outside the block. If verdict is "ok", findings must be [].',
  ].join('\n');
}

function parseReviewReply(text, expectedRevision) {
  const raw = String(text || '').trim();
  const first = raw.split('\n')[0].trim();
  if (!/^REVIEW(?![\w=])/i.test(first)) {
    return { status: 'invalid', reason: 'missing REVIEW marker', findings: [], verdict: '' };
  }
  let obj;
  try {
    obj = JSON.parse(raw.slice(first.length).trim());
  } catch (e) {
    return { status: 'invalid', reason: 'review JSON is invalid: ' + e.message, findings: [], verdict: '' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { status: 'invalid', reason: 'review must be a JSON object', findings: [], verdict: '' };
  }
  const verdict = String(obj.verdict || '');
  if (!['ok', 'findings'].includes(verdict)) {
    return { status: 'invalid', reason: 'review verdict must be ok or findings', findings: [], verdict };
  }
  const revision = String(obj.revision || '');
  if (!revision || revision !== expectedRevision) {
    return {
      status: 'invalid',
      reason: 'review revision mismatch (expected ' + expectedRevision + ', got ' + (revision || 'none') + ')',
      findings: [],
      verdict,
      revision,
    };
  }
  const findings = (Array.isArray(obj.findings) ? obj.findings : []).slice(0, 20)
    .map((f) => ({
      issue: progressText(f && f.issue, 300),
      affectedCriteria: progressText(f && f.affectedCriteria, 200),
      evidence: progressText(f && f.evidence, 300),
      severity: progressText(f && f.severity, 40),
    }))
    .filter((f) => f.issue);
  if (verdict === 'findings' && !findings.length) {
    return { status: 'invalid', reason: 'verdict findings without findings[]', findings: [], verdict };
  }
  if (verdict === 'ok' && findings.length) {
    return { status: 'invalid', reason: 'verdict ok with findings[]', findings: [], verdict };
  }
  return {
    status: 'reviewed',
    verdict,
    findings,
    revision,
    evidenceRef: progressText(obj.evidenceRef, 200),
  };
}

function formatReviewFindings(review) {
  return (review.findings || []).map((f, i) => [
    (i + 1) + '. ' + f.issue,
    f.affectedCriteria ? '   criteria: ' + f.affectedCriteria : '',
    f.evidence ? '   evidence: ' + f.evidence : '',
  ].filter(Boolean).join('\n')).join('\n');
}

async function runIndependentReview(page, ver) {
  const mode = CFG.reviewMode;
  const revision = ver.revision || 'unconfigured';
  if (mode === 'off') {
    const skipped = {
      status: 'skipped',
      verdict: '',
      findings: [],
      revision,
      evidenceRef: null,
      attempts: state.review.attempts || 0,
      at: Date.now(),
    };
    state.review = { ...(state.review || {}), ...skipped };
    saveState();
    return skipped;
  }
  const cached = state.review && state.review.checkedRevisions
    ? state.review.checkedRevisions[revision] : null;
  if (cached && cached.status === 'reviewed') return cached;
  state.review = state.review || {};
  state.review.attempts = (state.review.attempts || 0) + 1;
  if (state.review.attempts > CFG.reviewMax) {
    const unavailable = {
      status: 'unavailable',
      reason: 'review budget reached (' + CFG.reviewMax + ')',
      verdict: '',
      findings: [],
      revision,
      evidenceRef: null,
      attempts: state.review.attempts,
      at: Date.now(),
    };
    state.review = { ...state.review, ...unavailable };
    saveState();
    return unavailable;
  }

  emitPhase('reviewing', { revision, attempt: state.review.attempts });
  // A review chat is separate from the implementation chat. The mock keeps
  // its scripted page in place so fixtures can drive reviewer replies.
  if (!CFG.mock) {
    try {
      await resetChat(page);
      const ready = await firstVisible(page, SEL.composer, 30000);
      if (!ready) throw new Error('review chat did not open a composer');
      emitPhase('reviewing', { revision, attempt: state.review.attempts, chat: 'separate' });
    } catch (e) {
      const result = {
        status: 'unavailable',
        reason: 'review chat unavailable: ' + e.message,
        verdict: '',
        findings: [],
        revision,
        evidenceRef: null,
        attempts: state.review.attempts,
        at: Date.now(),
      };
      state.review = { ...(state.review || {}), ...result };
      saveState();
      emitEvent('review.result', result);
      return result;
    }
  }

  const prompt = buildReviewPrompt(ver) + '\n\n' + skillsPromptBlock();
  let reply;
  try {
    const before = await sendPrompt(page, prompt);
    reply = await waitForReply(page, before, Date.now() + CFG.maxTurnMs);
  } catch (e) {
    const status = e.code === 'turn_timeout' ? 'timed_out' : 'unavailable';
    const result = {
      status,
      reason: e.message,
      verdict: '',
      findings: [],
      revision,
      evidenceRef: null,
      attempts: state.review.attempts,
      at: Date.now(),
    };
    state.review = { ...(state.review || {}), ...result };
    saveState();
    emitEvent('review.result', result);
    return result;
  }

  let parsed;
  if (!reply || reply.kind !== 'block') {
    parsed = { status: 'invalid', reason: 'reviewer replied without a fenced block', findings: [], verdict: '' };
  } else {
    parsed = parseReviewReply(reply.text, revision);
  }

  let artifactRef = null;
  try {
    const dir = path.join(runDir(), 'review');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, revision.slice(0, 12) + '-' + state.review.attempts + '.txt');
    fs.writeFileSync(outPath, [
      '# review attempt: ' + state.review.attempts,
      '# revision: ' + revision,
      '# status: ' + parsed.status,
      '',
      '## prompt',
      prompt,
      '',
      '## reply',
      reply ? reply.text : '(none)',
      '',
      '## parsed',
      JSON.stringify(parsed, null, 2),
    ].join('\n'));
    artifactRef = path.relative(runDir(), outPath).split(path.sep).join('/');
  } catch {}

  const result = {
    ...parsed,
    revision: parsed.revision || revision,
    evidenceRef: parsed.evidenceRef || null,
    artifactRef,
    attempts: state.review.attempts,
    at: Date.now(),
  };
  state.review = { ...(state.review || {}), ...result };
  state.review.checkedRevisions = state.review.checkedRevisions || {};
  state.review.checkedRevisions[revision] = result;
  saveState();
  emitEvent('review.result', result);
  return result;
}


function nextActionId() {
  state.actionSeq = (Number(state.actionSeq) || 0) + 1;
  return state.actionSeq;
}

function beginAction(id, kind, turn, details = {}) {
  state.actions = (state.actions && typeof state.actions === 'object') ? state.actions : {};
  state.actions[id] = {
    id,
    kind,
    turn,
    status: 'started',
    startedAt: Date.now(),
    ...details,
  };
  // Durable before any side effect. If this throws, the caller must abort
  // before spawning or uploading, and no phantom `started` action remains.
  try {
    saveState('action_started');
  } catch (e) {
    delete state.actions[id];
    throw e;
  }
  emitEvent('action.started', { kind, turn, actionId: id });
  emitPhase('running', { kind, actionId: id, turn });
  return state.actions[id];
}

function finishAction(id, outcome, artifactRefs) {
  const action = state && state.actions && state.actions[id];
  if (!action) return;
  action.status = 'finished';
  action.finishedAt = Date.now();
  action.outcome = outcome || {};
  if (artifactRefs) action.artifactRefs = artifactRefs;
  try {
    saveState('action_finished');
  } catch (e) {
    log('WARN: could not persist finished action ' + id + ': ' + e.message);
  }
}

/* ------------------------------------------------------------ fs memory */

function memoryDir() {
  return path.join(CFG.workdir, '.harness');
}

function ensureGitExclude() {
  const root = findProjectRoot();
  if (!fs.existsSync(path.join(root, '.git'))) return;

  // Prefer <git-dir>/info/exclude: local, untracked, and it cannot dirty the
  // repo the way appending to .gitignore does. rev-parse also resolves
  // worktrees, where .git is a file.
  let target = null;
  try {
    let gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (gitDir) {
      if (!path.isAbsolute(gitDir)) gitDir = path.join(root, gitDir);
      const info = path.join(gitDir, 'info');
      fs.mkdirSync(info, { recursive: true });
      target = path.join(info, 'exclude');
    }
  } catch {}
  if (!target) target = path.join(root, '.gitignore');

  try {
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (!cur.split('\n').map((l) => l.trim()).includes('.harness/')) {
      fs.appendFileSync(target, (cur && !cur.endsWith('\n') ? '\n' : '') + '.harness/\n');
    }
  } catch {}
}

function ensureMemory() {
  const dir = memoryDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['PLAN.md', 'NOTES.md']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
  ensureGitExclude();
}

function clampTail(text, max) {
  if (text.length <= max) return text;
  return '[... trimmed to the last ' + max + ' chars ...]\n' + text.slice(-max);
}

function readMemoryFile(name) {
  try {
    const p = path.join(memoryDir(), name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function archiveMemory() {
  const dir = memoryDir();
  const names = ['PLAN.md', 'NOTES.md', 'REVIEW.md'];
  if (!names.some((n) => fs.existsSync(path.join(dir, n)))) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, 'archive', stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    const src = path.join(dir, name);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(dest, name));
  }
  log('archived previous plan/notes/review to ' + dest);
}

function syncMemory() {
  const rawPlan = readMemoryFile('PLAN.md');
  const rawNotes = readMemoryFile('NOTES.md');

  state.plan = clampTail(rawPlan, CFG.maxPlanChars);
  state.planOversize = rawPlan.length > CFG.maxPlanChars;
  state.notes = clampTail(rawNotes, CFG.maxNotesChars);
  state.notesOversize = rawNotes.length > CFG.maxNotesChars;

  const parsed = parsePlan(rawPlan);
  state.planTotal = parsed.total;
  state.planDone = parsed.done;
  state.planOpen = parsed.open;
  state.planRemaining = parsed.remaining;

  const instr = loadProjectInstructions();
  if (instr !== projectInstructions) {
    projectInstructions = instr;
    log(instr ? 'project instructions: ' + instr.length + ' chars' : 'project instructions: none');
  }

  const cmds = loadProjectCommands();
  if (cmds !== projectCommands) {
    projectCommands = cmds;
    if (cmds) log('project commands: ' + cmds);
  }
}

/*
 * Non-destructive safety net: record the dirty working tree as a commit object
 * without touching files or the index. If the agent wrecks tracked files, the
 * printed hash restores them: git reset --hard <hash>.
 * Untracked files are NOT covered by git stash create.
 */
function snapshotGit() {
  const root = findProjectRoot();
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) return;

  const run = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  try {
    if (!run(['status', '--porcelain'])) return;
    const hash = run(['stash', 'create']);
    if (!hash) return;
    run(['update-ref', 'refs/harness/' + Date.now(), hash]);
    state.gitSnapshot = hash;
    log('git snapshot: ' + hash.slice(0, 12) + '  (restore tracked files: git reset --hard ' + hash + ')');
  } catch (e) {
    log('WARN: git snapshot failed: ' + String(e.message || e).split('\n')[0]);
  }
}

/* ------------------------------------------------------- project knowledge */

const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];

function findProjectRoot() {
  let dir = CFG.workdir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return CFG.workdir;
}

function readTextFileSafe(p, maxBytes = 262144) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return '';
    return fs.readFileSync(p, 'utf8').replace(/\u0000/g, '').trim();
  } catch {
    return '';
  }
}

/*
 * Load AGENTS.md/CLAUDE.md from the project root down to WORKDIR, like Codex
 * and DeepSeek Harness. Broad files are dropped before specific ones when the
 * byte budget is tight; candidate content is deduplicated.
 */
function loadProjectInstructions() {
  const root = findProjectRoot();
  const dirs = [];
  let dir = CFG.workdir;
  for (;;) {
    dirs.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const entries = [];
  const seen = new Set();
  const add = (p) => {
    const text = readTextFileSafe(p);
    if (!text) return;
    const digest = crypto.createHash('sha1').update(text).digest('hex');
    if (seen.has(digest)) return;
    seen.add(digest);
    entries.push({ p, text });
  };

  for (const d of dirs) {
    for (const name of INSTRUCTION_NAMES) add(path.join(d, name));
    if (d === root) add(path.join(d, '.github', 'copilot-instructions.md'));
  }

  let budget = CFG.maxInstructionsChars;
  const kept = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const header = '--- ' + path.relative(CFG.workdir, e.p) + ' ---\n';
    const cost = header.length + e.text.length + 2;
    if (cost <= budget) {
      kept.unshift({ header, text: e.text });
      budget -= cost;
    } else if (!kept.length) {
      kept.unshift({ header, text: clampMiddle(e.text, Math.max(400, budget - header.length - 40)) });
      budget = 0;
    }
  }

  return kept.map((k) => k.header + k.text).join('\n\n');
}

function findUpFile(name) {
  const root = findProjectRoot();
  let dir = CFG.workdir;
  for (;;) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { dir, path: p };
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function withDir(dir, cmd) {
  const rel = path.relative(CFG.workdir, dir);
  // Subshell keeps the caller's cwd intact for the rest of the script.
  return rel ? '(cd ' + JSON.stringify(rel) + ' && ' + cmd + ')' : cmd;
}

function loadProjectCommands() {
  const out = [];

  const pkg = findUpFile('package.json');
  if (pkg) {
    const text = readTextFileSafe(pkg.path, 200000);
    try {
      const scripts = JSON.parse(text).scripts || {};
      for (const name of ['test', 'lint', 'typecheck', 'build', 'check']) {
        const body = String(scripts[name] || '');
        if (!body || /no test specified/i.test(body)) continue;
        out.push(withDir(pkg.dir, 'npm run ' + name));
      }
    } catch {}
  }

  const makefile = findUpFile('Makefile');
  if (makefile) {
    const text = readTextFileSafe(makefile.path, 200000);
    const targets = new Set(Array.from(text.matchAll(/^([A-Za-z0-9_.-]+):/gm), (m) => m[1]));
    for (const name of ['test', 'lint', 'build']) {
      if (targets.has(name)) out.push(withDir(makefile.dir, 'make ' + name));
    }
  }

  const cargo = findUpFile('Cargo.toml');
  if (cargo) out.push(withDir(cargo.dir, 'cargo test -q'));
  const go = findUpFile('go.mod');
  if (go) out.push(withDir(go.dir, 'go test ./...'));
  const pytest = findUpFile('pytest.ini');
  if (pytest) out.push(withDir(pytest.dir, 'pytest -q'));

  return Array.from(new Set(out)).slice(0, 6).join(', ');
}

function parsePlan(text) {
  let total = 0;
  let done = 0;
  const open = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    total++;
    if (m[1].toLowerCase() === 'x') done++;
    else if (open.length < 8) open.push(m[2].slice(0, 120));
  }
  return { total, done, open, remaining: total - done };
}

function canonicalScript(script) {
  return String(script || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() && !/^\s*#/.test(line))
    .join('\n');
}

/* ------------------------------------------------------- review / evidence */

function detectMode(goal) {
  const g = String(goal || '').toLowerCase();
  // Review is opt-in: explicit review/audit/analysis verbs. Do NOT treat every
  // "summary" or "read" in a build goal as a review (a harmless "give me a
  // short summary" used to force review mode and its evidence gate).
  const review = /\b(review|audit|evaluat\w*|assess|analy[sz]\w*|inspect|read-only|understand|explain)\b/
    .test(g)
    || /(đánh giá|phân tích|rà soát|soi|đọc|kiểm tra|hiểu)/.test(g);
  const build = /\b(fix|implement|add|remove|upgrade|migrat\w*|refactor|build|deploy|change|update)\b/
    .test(g)
    || /(sửa|nâng cấp|cài|triển khai|thêm|xóa|chạy test)/.test(g);
  return review && !build ? 'review' : 'build';
}

function mergeRanges(ranges) {
  const rs = (ranges || [])
    .map(([a, b]) => [Number(a), Number(b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const lineCountCache = new Map();

function fileLineCount(rel) {
  try {
    const p = path.isAbsolute(rel) ? rel : path.join(CFG.workdir, rel);
    const st = fs.statSync(p);
    const key = p + ':' + st.size + ':' + st.mtimeMs;
    if (lineCountCache.has(key)) return lineCountCache.get(key);
    const text = fs.readFileSync(p, 'utf8');
    const n = text.length ? text.split('\n').length : 0;
    lineCountCache.set(key, n);
    if (lineCountCache.size > 500) lineCountCache.clear();
    return n;
  } catch {
    return 0;
  }
}

function normalizeRel(f) {
  const abs = path.resolve(CFG.workdir, String(f || ''));
  return path.relative(CFG.workdir, abs) || path.basename(abs);
}

function resolveReadPath(token) {
  let t = String(token || '').trim().replace(/^['"]|['"]$/g, '');
  if (!t || t.startsWith('-') || /[|;&]/.test(t)) return '';
  const abs = path.resolve(CFG.workdir, t);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > 1048576) return '';
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, n).indexOf(0) !== -1) return '';
  } catch {
    return '';
  }
  return path.relative(CFG.workdir, abs) || path.basename(abs);
}

function addReadRange(rel, from, to) {
  if (!state) return;
  const total = fileLineCount(rel);
  if (!total) return;
  const a = Math.max(1, Math.min(Number(from) || 1, total));
  const b = Math.max(a, Math.min(Number(to) || total, total));
  if (!state.reads || typeof state.reads !== 'object') state.reads = {};
  const ranges = state.reads[rel] || [];
  ranges.push([a, b]);
  state.reads[rel] = ranges.length > 200 ? mergeRanges(ranges) : ranges;
  state.readOrder = (state.readOrder || []).filter((x) => x !== rel);
  state.readOrder.push(rel);
  if (state.readOrder.length > 30) state.readOrder.shift();
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] || m[2] || m[3]);
  return out.filter((x) => x && !x.startsWith('-'));
}

/*
 * Track only the part of a file the model actually saw. If a 500-line cat was
 * truncated to 140 head lines, coverage is 1-140, not 1-500.
 */
function trackReads(script, obs) {
  const headShown = obs && obs.headShown ? obs.headShown : CFG.maxObsHead;
  const truncated = !!(obs && obs.truncated);
  const ops = [];

  const pushOp = (file, from, to, lines) => {
    const rel = resolveReadPath(file);
    if (!rel) return;
    const total = fileLineCount(rel);
    if (!total) return;
    const a = Math.max(1, Math.min(Number(from) || 1, total));
    const b = Math.max(a, Math.min(Number(to) || total, total));
    ops.push({
      rel,
      a,
      b,
      lines: Math.max(1, Math.min(Number(lines) || (b - a + 1), b - a + 1)),
    });
  };

  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /(^|[^0-9])>{1,2}\s*[^&]/.test(line)) continue;

    let m = /^sed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+(.+)$/.exec(line);
    if (m) {
      pushOp(m[3].split('|')[0].trim(), +m[1], +m[2], +m[2] - +m[1] + 1);
      continue;
    }

    m = /^head\s+(?:-n\s*)?(\d+)\s+(.+)$/.exec(line);
    if (m) {
      pushOp(m[2].split('|')[0].trim(), 1, +m[1], +m[1]);
      continue;
    }

    m = /^tail\s+(?:-n\s*)?(\d+)\s+(.+)$/.exec(line);
    if (m) {
      const target = m[2].split('|')[0].trim();
      const rel = resolveReadPath(target);
      const total = rel ? fileLineCount(rel) : 0;
      if (total) pushOp(target, total - (+m[1]) + 1, total, +m[1]);
      continue;
    }

    m = /^cat\s+(.+)$/.exec(line);
    if (m && !line.includes('|')) {
      const files = splitArgs(m[1]);
      if (files.length === 1) {
        const rel = resolveReadPath(files[0]);
        const total = rel ? fileLineCount(rel) : 0;
        if (total) pushOp(files[0], 1, total, total);
      }
      continue;
    }

    m = /^nl\s+(?:-ba\s+)?(.+)$/.exec(line);
    if (m) {
      const files = splitArgs(m[1]);
      if (files.length === 1) {
        const rel = resolveReadPath(files[0]);
        const total = rel ? fileLineCount(rel) : 0;
        if (total) pushOp(files[0], 1, total, total);
      }
    }
  }

  // Map the visible head and tail of the combined output back to file lines.
  // A later command may sit in the omitted middle, so it is not evidence.
  const totalOut = obs && obs.lines ? obs.lines : ops.reduce((n, op) => n + op.lines, 0);
  const tailShown = obs && obs.tailShown ? obs.tailShown : CFG.maxObsTail;
  const tailStart = Math.max(0, totalOut - tailShown);
  const headEnd = Math.min(headShown - 1, totalOut - 1);
  const spans = truncated
    ? [[0, headEnd], [tailStart, totalOut - 1]]
    : [[0, totalOut - 1]];

  let cursor = 0;
  for (const op of ops) {
    const opStart = cursor;
    const opEnd = cursor + op.lines - 1;
    for (const [spanStart, spanEnd] of spans) {
      const a = Math.max(opStart, spanStart);
      const b = Math.min(opEnd, spanEnd);
      if (a > b) continue;
      const fileA = op.a + (a - opStart);
      const fileB = Math.min(op.b, op.a + (b - opStart));
      if (fileB >= fileA) addReadRange(op.rel, fileA, fileB);
    }
    cursor = opEnd + 1;
  }
}

function formatReadCoverage() {
  const order = Array.isArray(state.readOrder) ? state.readOrder : [];
  if (!order.length) return 'READ COVERAGE: no files read yet.';
  const lines = ['READ COVERAGE (harness-observed; visible head + tail are counted):'];
  for (const rel of order.slice().reverse().slice(0, 12)) {
    const ranges = mergeRanges(state.reads[rel] || []);
    if (!ranges.length) continue;
    const total = fileLineCount(rel);
    const covered = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    const pct = total ? Math.round((covered * 100) / total) : 0;
    const span = ranges.slice(0, 6).map(([a, b]) => a + '-' + b).join(', ')
      + (ranges.length > 6 ? ', ...' : '');
    lines.push('- ' + rel + ': ' + span + (total ? ' (' + covered + '/' + total + ', ' + pct + '%)' : ''));
  }
  return lines.join('\n');
}

const SCOPE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next', 'coverage',
  'vendor', '.venv', '__pycache__', '.harness', '.idea', '.vscode', '.cache', 'tmp',
]);

const SCOPE_TEXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|kts|cs|rb|php|swift|c|h|cc|cpp|hpp|scala|sh|bash|zsh|sql|graphql|gql|proto|yaml|yml|json|toml|ini|cfg|md|txt|xml|html|css|scss|less|vue|svelte|astro)$/i;

function walkScope(dir, files, depth = 0) {
  if (depth > 8 || files.size >= CFG.maxScopeFiles) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (files.size >= CFG.maxScopeFiles) return;
    if (it.name.startsWith('.')) continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SCOPE_SKIP_DIRS.has(it.name)) continue;
      walkScope(p, files, depth + 1);
    } else if (it.isFile()) {
      if (!SCOPE_TEXT_RE.test(it.name)) continue;
      if (/^(package-lock|pnpm-lock|yarn\.lock)/i.test(it.name)) continue;
      try {
        if (fs.lstatSync(p).size > 262144) continue;
      } catch { continue; }
      files.add(path.relative(CFG.workdir, p));
    }
  }
}

function extractScope(goal) {
  const files = new Set();
  const text = String(goal || '');
  const re = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@.+-]+\.\w{1,10})(?=[\s"'`),.:;]|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const cand = m[1].replace(/[.,:;]+$/, '');
    const abs = path.resolve(CFG.workdir, cand);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isFile()) {
      files.add(path.relative(CFG.workdir, abs));
    } else if (st.isDirectory()) {
      if (SCOPE_SKIP_DIRS.has(path.basename(abs))) continue;
      walkScope(abs, files);
    }
    if (files.size >= CFG.maxScopeFiles) break;
  }
  return Array.from(files).slice(0, CFG.maxScopeFiles);
}

function formatScope() {
  const scope = Array.isArray(state.scope) ? state.scope : [];
  if (!scope.length) {
    return 'SCOPE FILES: no directory/file path was detected in the goal. List the files to read in PLAN.md.';
  }
  const reads = state.reads || {};
  const readCount = scope.filter((f) => (reads[f] || []).length > 0).length;
  const lines = ['SCOPE FILES (from goal): ' + scope.length + ' total, '
    + readCount + ' read, ' + (scope.length - readCount) + ' unread'];
  for (const f of scope.slice(0, CFG.maxScopeShown)) {
    const ranges = mergeRanges(reads[f] || []);
    const total = fileLineCount(f);
    const covered = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    const tag = ranges.length
      ? '[read ' + (total ? Math.round((covered * 100) / total) : 0) + '%]'
      : '[unread]';
    lines.push('- ' + tag + ' ' + f);
  }
  if (scope.length > CFG.maxScopeShown) {
    lines.push('- ... and ' + (scope.length - CFG.maxScopeShown) + ' more');
  }
  return lines.join('\n');
}

function reviewGateText(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'REVIEW.md is missing or empty' };
  if (/^\s*(TODO|TBD|FIXME)\s*:?\s*$/im.test(t) || /^\s*-\s*\[\s*\]\s*(TODO|TBD)\b/im.test(t)) {
    return { ok: false, reason: 'REVIEW.md still has TODO/TBD placeholders' };
  }
  if (!/^##\s+Files read\b/im.test(t)) {
    return { ok: false, reason: 'REVIEW.md is missing the "## Files read" section' };
  }
  const findings = /##\s+Findings\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(t);
  if (!findings) {
    return { ok: false, reason: 'REVIEW.md is missing the "## Findings" section' };
  }

  const entries = [];
  const re = /(?:^|[\s(`"'\[])((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]+):(\d+)/g;
  let m;
  while ((m = re.exec(findings[1]))) entries.push({ file: m[1], line: +m[2] });
  const files = Array.from(new Set(entries.map((e) => e.file)));
  if (entries.length < 2) {
    return { ok: false, reason: 'needs at least 2 findings with path:line evidence' };
  }
  return { ok: true, entries, citations: entries.length, files };
}

function reviewGate() {
  const text = readMemoryFile('REVIEW.md');
  const base = reviewGateText(text);
  if (!base.ok) return base;

  const entries = base.entries.filter((e) => {
    try { return fs.statSync(path.resolve(CFG.workdir, e.file)).isFile(); } catch { return false; }
  });
  if (entries.length < 2) {
    return { ok: false, reason: 'fewer than 2 citations point to existing files' };
  }

  const files = Array.from(new Set(entries.map((e) => e.file)));
  const reads = state.reads || {};
  const unread = files.filter((f) => {
    const rel = normalizeRel(f);
    return !(reads[rel] && reads[rel].length);
  });
  if (unread.length) {
    return {
      ok: false,
      reason: 'cited but not read with sed/cat: ' + unread.slice(0, 5).join(', ')
        + (unread.length > 5 ? ' (+' + (unread.length - 5) + ')' : ''),
      files,
    };
  }

  const uncovered = entries.filter((e) => {
    const rel = normalizeRel(e.file);
    const ranges = mergeRanges(reads[rel] || []);
    return !ranges.some(([a, b]) => e.line >= a && e.line <= b);
  });
  if (uncovered.length) {
    const shown = uncovered.slice(0, 5).map((e) => {
      const rel = normalizeRel(e.file);
      const ranges = mergeRanges(reads[rel] || []);
      return e.file + ':' + e.line + ' (read ' + ranges.map(([a, b]) => a + '-' + b).join(', ') + ')';
    });
    return {
      ok: false,
      reason: 'cited lines are not in READ COVERAGE: ' + shown.join('; ')
        + (uncovered.length > 5 ? ' (+' + (uncovered.length - 5) + ')' : ''),
      files,
    };
  }

  const scope = Array.isArray(state.scope) ? state.scope : [];
  const unreadScope = scope.filter((f) => !(reads[f] && reads[f].length));
  if (unreadScope.length) {
    const section = /##\s+Unverified\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(text);
    if (!section) {
      return {
        ok: false,
        reason: 'add a "## Unverified" section listing unread scope files: '
          + unreadScope.slice(0, 5).join(', ')
          + (unreadScope.length > 5 ? ' (+' + (unreadScope.length - 5) + ')' : ''),
        files,
      };
    }
    const missing = unreadScope.filter((f) => !section[1].includes(f));
    if (missing.length) {
      return {
        ok: false,
        reason: 'these scope files were not read and not listed under "## Unverified": '
          + missing.slice(0, 5).join(', ')
          + (missing.length > 5 ? ' (+' + (missing.length - 5) + ')' : ''),
        files,
      };
    }
  }

  return { ok: true, citations: entries.length, files };
}

function isReadHeavy(script) {
  const lines = String(script || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return false;

  const write = /(^|[\s;&|])(rm|mv|cp|mkdir|touch|chmod|chown|tee|truncate|dd|npm|yarn|pnpm|bun|cargo|go|make|pytest|python|node|git\s+(add|commit|push|checkout|reset|clean|stash|apply|merge|rebase))(\s|$)/;
  const redirect = /(^|[^0-9])>{1,2}\s*[^&]/;
  const findWrite = /\bfind\b[^\n]*\s(-delete|-exec)\b/;
  if (lines.some((l) => write.test(l) || redirect.test(l) || findWrite.test(l))) return false;

  const read = /(^|[\s;&|])(cat|sed\s+-n|head|tail|less|more|nl|wc|ls|find|tree|rg|grep|awk|cut|sort|uniq|file|stat|jq|yq|bat|git\s+(status|log|show|diff|blame|grep))(\s|$)/;
  return lines.some((l) => read.test(l));
}

function readHint(script) {
  const line = String(script || '').split('\n').map((l) => l.trim())
    .find((l) => /^(sed\s+-n|head|cat|nl)\b/.test(l));
  if (!line) return '';

  let file = '';
  let from = 1;
  let to = 0;
  let m = /^sed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+(.+)$/.exec(line);
  if (m) {
    from = +m[1];
    to = +m[2];
    file = m[3];
  } else {
    m = /^head\s+(?:-n\s*)?(\d+)\s+(.+)$/.exec(line);
    if (m) {
      from = 1;
      to = +m[1];
      file = m[2];
    } else {
      m = /^cat\s+(.+)$/.exec(line) || /^nl\s+(?:-ba\s+)?(.+)$/.exec(line);
      if (m) file = m[1];
    }
  }

  file = String(file || '').split('|')[0].trim();
  const rel = resolveReadPath(file);
  if (!rel) return '';
  const total = fileLineCount(rel);
  if (!total) return '';
  if (!to || to > total) to = total;
  if (to - from + 1 <= CFG.maxReadObsHead) return '';

  const next = from + CFG.maxReadObsHead;
  const end = Math.min(to, next + CFG.maxReadObsHead - 1);
  return "sed -n '" + next + ',' + end + "p' " + JSON.stringify(rel);
}

function gitBranch() {
  const root = findProjectRoot();
  if (!fs.existsSync(path.join(root, '.git'))) return '';
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return '';
  }
}

function gitSummary() {
  if (!CFG.gitObserve) return '';
  const root = findProjectRoot();
  if (!fs.existsSync(path.join(root, '.git'))) return '';

  const run = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  }).trim();

  try {
    const status = run(['status', '--porcelain']);
    if (!status) return '';
    // Never show the harness's own memory directory to the model.
    const lines = status.split('\n').filter((l) => !l.includes('.harness/'));
    let out = lines.slice(0, 12).join('\n');
    if (lines.length > 12) out += '\n... (' + (lines.length - 12) + ' more)';
    try {
      const stat = run(['diff', 'HEAD', '--stat']);
      const last = stat.split('\n').filter(Boolean).pop();
      if (last) out += '\n' + last;
    } catch {}
    return out;
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------- DOM helpers */

async function firstVisible(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(120);
  }
  return null;
}

/*
 * One CDP round-trip per poll: stop-button state + code blocks + turn count.
 * The previous version issued 10+ locator calls per poll (5 stop selectors with
 * count/isVisible, 4 block selectors, 3 turn selectors), which dominated the
 * poll loop on a long conversation.
 */
async function snapshot(page) {
  return page.evaluate((sels) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    let generating = false;
    for (const sel of sels.stop) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        if (visible(el)) { generating = true; break; }
      }
      if (generating) break;
    }

    const blocks = [];
    const seenEl = new Set();

    // Scope code blocks to the LAST assistant turn when one can be identified,
    // so a stale block from an earlier message can never be mistaken for the
    // current reply. Falls back to the whole page for unknown DOM shapes.
    let scope = null;
    for (const sel of sels.turn) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (visible(nodes[i])) { scope = nodes[i]; break; }
      }
      if (scope) break;
    }
    const root = scope || document;

    for (const sel of sels.code) {
      let nodes;
      try { nodes = root.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        if (!visible(el)) continue;
        // Keep the innermost element only: a data-code-block wrapper and its
        // <pre>/<code> child carry the same text. Never dedupe by TEXT: two
        // turns may legitimately produce the exact same command, and dropping
        // the second copy makes the reply invisible to waitForReply.
        if (el.querySelector('pre, code')) continue;
        if (seenEl.has(el)) continue;
        seenEl.add(el);
        const t = (el.innerText || '').trim();
        if (t) blocks.push(t);
      }
    }

    let turns = 0;
    for (const sel of sels.turn) {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch { continue; }
      if (n > 0) { turns = n; break; }
    }

    return { generating, blocks, turns };
  }, { stop: SEL.stop, code: SEL.code, turn: SEL.turn })
    .catch(() => ({ generating: false, blocks: [], turns: 0 }));
}

function cleanBlock(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    // Copilot's code renderer sometimes emits NBSP or zero-width characters
    // (especially on blank lines inside heredocs). Bash treats NBSP as a word.
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .split('\n')
    .filter((line) => !/^\s*(copy|copy code)\s*$/i.test(line));

  // Some layouts put the language label inside the scraped text.
  if (lines.length > 1 && /^(bash|sh|shell|zsh|console|powershell)$/i.test(lines[0].trim())) lines.shift();

  return lines.join('\n').trim();
}

async function marks(page) {
  const s = await snapshot(page);
  return {
    blocks: s.blocks.length,
    turns: s.turns,
    texts: new Set(s.blocks.map((b) => b.trim())),
  };
}

/* Saved only on failure, for debugging the scraped page. */
async function dumpPage(page, tag) {
  try {
    const text = await page.evaluate(() => document.body.innerText);
    const p = path.join(CFG.home, tag + '.txt');
    fs.writeFileSync(p, text, 'utf8');
    log('page text saved: ' + p);
    return p;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- attachments */

const SECRET_NAME_RE = /(^|\/)(\.env(\..*)?|\.netrc|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(pem|key|p12|pfx))$/i;
const SECRET_DIR_RE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)/i;

function resolveAttachment(rel) {
  if (!rel || typeof rel !== 'string') {
    throw new HarnessError('attach_invalid', 'ATTACH needs {"file":"relative/path"}');
  }
  const root = fs.realpathSync(CFG.workdir);
  const abs = path.resolve(root, rel);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new HarnessError('attach_missing', 'Attachment not found: ' + rel);
  }
  const relReal = path.relative(root, real);
  if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new HarnessError('attach_outside', 'Refusing to attach a file outside WORKDIR: ' + rel);
  }
  const posixRel = relReal.split(path.sep).join('/');
  if (SECRET_NAME_RE.test(posixRel) || SECRET_DIR_RE.test(posixRel)) {
    throw new HarnessError('attach_secret', 'Refusing to attach a secret-looking file: ' + posixRel);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) {
    throw new HarnessError('attach_not_file', 'Attachment is not a regular file: ' + relReal);
  }
  if (st.size > CFG.attachMaxBytes) {
    throw new HarnessError('attach_too_big',
      'Attachment is ' + st.size + ' bytes (max ' + CFG.attachMaxBytes + '): ' + relReal);
  }
  if (st.size === 0) {
    throw new HarnessError('attach_empty', 'Attachment is empty: ' + relReal);
  }
  return { abs: real, rel: posixRel, size: st.size };
}

async function uploadAttachment(page, absPath) {
  let input = page.locator(SEL.fileInput).first();
  let count = await input.count().catch(() => 0);

  if (!count) {
    const btn = await firstVisible(page, SEL.attach, 3000);
    if (btn) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
      input = page.locator(SEL.fileInput).first();
      count = await input.count().catch(() => 0);
    }
  }

  if (!count) {
    throw new HarnessError('no_file_input',
      'No file input found on the Copilot page. Run --probe and update SEL.attach/fileInput.');
  }

  await input.setInputFiles(absPath, { timeout: 30000 });
  await page.waitForTimeout(CFG.attachWaitMs);

  // Give the UI a moment to register the upload. Not every file type shows its
  // name (images often become thumbnails), so a miss here is only a warning.
  const base = path.basename(absPath);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const seen = await page.evaluate((name) => document.body.innerText.includes(name), base)
      .catch(() => false);
    if (seen) return true;
    await page.waitForTimeout(250);
  }
  log('WARN: uploaded ' + base + ' but its name is not visible in the page; continuing');
  return false;
}

/* ------------------------------------------------------------------- send */

async function sendPrompt(page, promptText) {
  const composer = await firstVisible(page, SEL.composer, 20000);
  if (!composer) {
    throw new HarnessError('no_composer', 'Composer not found. Run: node agent.js --probe');
  }

  const tag = await composer.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'textarea' || tag === 'input') {
    await composer.fill(promptText);
  } else {
    // Lexical / RoosterJS editors: fill() can collapse newlines.
    await composer.fill('');
    await composer.click().catch(() => {});
    await page.keyboard.insertText(promptText);
  }
  await page.waitForTimeout(150);

  const before = await marks(page);

  const sendBtn = await firstVisible(page, SEL.send, 1200);
  if (sendBtn) {
    await sendBtn.click({ timeout: 2000 }).catch(async () => { await page.keyboard.press('Enter'); });
  } else {
    await page.keyboard.press('Enter');
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    if (s.generating) return before;
    if (s.blocks.length > before.blocks) return before;
    if (before.turns > 0 && s.turns > before.turns) return before;
  }

  log('WARN: no sign the message was sent; continuing anyway');
  return before;
}

/* ------------------------------------------------------------- wait reply */

async function waitForReply(page, before, deadline) {
  let started = false;
  let sawGenerating = false;
  let endedAt = 0;
  let candidate = '';
  let stable = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(CFG.pollMs);
    const s = await snapshot(page);
    const lastBlock = s.blocks.length ? s.blocks[s.blocks.length - 1].trim() : '';
    // Count is the primary signal. Unseen text also covers conversations where
    // offscreen turns stop being rendered, so the count stays flat while a new
    // block appears. Text already present before the turn never counts as new.
    const grew = s.blocks.length > before.blocks
      || (lastBlock !== '' && !before.texts.has(lastBlock));

    // A turn starts when the Stop button appears, a code block is appended, or
    // a new message element shows up.
    if (!started) {
      if (s.generating || grew) started = true;
      else if (before.turns > 0 && s.turns > before.turns) started = true;
      else continue;
    }

    if (s.generating) {
      sawGenerating = true;
      endedAt = 0;
      stable = 0;
      candidate = '';
      continue;
    }

    if (grew) {
      const last = s.blocks[s.blocks.length - 1];
      if (last === candidate) {
        if (++stable >= CFG.stablePolls) return { kind: 'block', text: cleanBlock(last) };
      } else {
        candidate = last;
        stable = 0;
      }
      continue;
    }

    // Generation finished but appended no code block: the model answered with
    // prose (or forgot the fence). Report it after a short grace period
    // instead of burning the whole 180s deadline.
    if (sawGenerating) {
      if (!endedAt) endedAt = Date.now();
      else if (Date.now() - endedAt >= CFG.postGenGraceMs) return { kind: 'prose' };
    }
  }

  throw new HarnessError('turn_timeout', 'Copilot did not finish within ' + Math.round((deadline - Date.now()) / 1000) + 's');
}

/* ------------------------------------------------------------------ parse */

function parseReply(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };

  const first = t.split('\n')[0].trim();

  // A lone language label is not a script. Do NOT strip "bash" when it is
  // followed by a filename: "bash run.sh" is a valid command.
  if (/^(bash|sh|shell|zsh|console|powershell)$/i.test(first) && t.split('\n').length === 1) {
    return { kind: 'empty' };
  }

  if (/^DONE(?![\w=])/i.test(first)) {
    const summary = t.slice(first.length).trim();
    return { kind: 'done', summary: summary || '(no summary)' };
  }

  if (/^BLOCKED(?![\w=])/i.test(first)) {
    const summary = t.slice(first.length).trim();
    return { kind: 'blocked', summary: summary || '(no reason given)' };
  }

  if (/^COMPACT(?![\w=])/i.test(first)) {
    const summary = t.slice(first.length).trim();
    return { kind: 'compact', summary: summary || '(no summary)' };
  }

  if (/^ATTACH(?![\w=])/i.test(first)) {
    const raw = t.slice(first.length).trim();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    return { kind: 'attach', payload, raw };
  }

  return { kind: 'script', script: t };
}

/* ---------------------------------------------------------------- policy */

const POLICY = [
  { re: /\bsudo\b/, why: 'sudo is not allowed' },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:~\/?|\/\*|\/)(?=[\s;&|]|$)/m, why: 'refusing rm on / or ~' },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:\.|\.\.(?:\/\S*)?|\*|\.\/\*|\$HOME(?:\/\S*)?)(?=[\s;&|]|$)/m, why: 'refusing rm on . .. * or $HOME' },
  { re: /(?:\\|\bcommand\s+)\brm\b/, why: 'obfuscated rm is not allowed' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard is not allowed' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, why: 'git clean -fd is not allowed' },
  { re: /\bgit\s+push\b[^\n]*(-f\b|--force\b|--force-with-lease\b)/, why: 'forced git push is not allowed' },
  { re: /\bmkfs(\.|\s)/, why: 'mkfs is not allowed' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: 'raw device write is not allowed' },
  { re: /\b(shutdown|reboot|halt|killall)\b/, why: 'system commands are not allowed' },
  { re: /\bcurl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, why: 'piping curl into a shell is not allowed' },
  { re: /\bwget\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, why: 'piping wget into a shell is not allowed' },
  { re: /(?:cat|less|more|head|tail|grep|rg|awk|sed)\b[^\n]*(?:\.ssh\/|id_rsa|\.aws\/credentials|\.config\/gh\/hosts\.yml|\.netrc)/, why: 'refusing to read credential files' },
];

function checkPolicy(script) {
  // v4: the deny list is always on, including in yolo mode. --yolo only
  // removes the per-action approval step, not the catastrophic-command filter.
  for (const rule of POLICY) {
    if (rule.re.test(script)) return { ok: false, reason: rule.why };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------- exec */

function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

async function executeScript(script, turn) {
  const turnDir = path.join(CFG.home, 'runs', CFG.runId || 'adhoc', 'turns', String(turn).padStart(3, '0'));
  fs.mkdirSync(turnDir, { recursive: true });

  const normalized = String(script || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  // Fix the exact content BEFORE approval so what runs is what was approved.
  fs.writeFileSync(path.join(turnDir, 'script.sh'), 'set -o pipefail\n' + normalized + '\n', 'utf8');
  fs.writeFileSync(path.join(turnDir, 'reply.md'), normalized, 'utf8');
  const artifactRefs = ['script.sh', 'output.txt']
    .map((f) => path.relative(runDir(), path.join(turnDir, f)).split(path.sep).join('/'));

  const actionId = nextActionId();
  emitEvent('action.proposed', {
    kind: 'bash',
    turn,
    actionId,
    script: normalized,
    workspace: CFG.workdir,
  });

  const verdict = checkPolicy(normalized);
  if (!verdict.ok) {
    const msg = 'DENIED BY HARNESS POLICY: ' + verdict.reason;
    log(msg);
    fs.writeFileSync(path.join(turnDir, 'output.txt'), msg + '\n', 'utf8');
    emitEvent('action.finished', { kind: 'bash', turn, actionId, exit: 126, denied: true, reason: verdict.reason });
    return {
      exit: 126,
      output: msg,
      durationMs: 0,
      bytes: msg.length,
      runDir: turnDir,
      denied: true,
    };
  }

  const approval = await requestApproval('bash', { script: normalized, turn }, actionId);
  if (!approval.approve) {
    const msg = 'DENIED BY USER (' + (approval.reason || 'no reason') + '): action not executed.'
      + ' Adjust the approach or reply DONE if the goal is already met.';
    log(msg);
    fs.writeFileSync(path.join(turnDir, 'output.txt'), msg + '\n', 'utf8');
    emitEvent('action.finished', { kind: 'bash', turn, actionId, exit: 125, denied: true, reason: approval.reason });
    return {
      exit: 125,
      output: msg,
      durationMs: 0,
      bytes: msg.length,
      runDir: turnDir,
      denied: true,
    };
  }

  beginAction(actionId, 'bash', turn, {
    script: normalized.slice(0, 4000),
    artifactRefs,
  });
  const readHeavy = isReadHeavy(normalized);

  return await new Promise((resolve) => {
    const started = Date.now();
    const scriptPath = path.join(turnDir, 'script.sh');
    const outPath = path.join(turnDir, 'output.txt');
    const out = fs.createWriteStream(outPath);

    let bytes = 0;
    let liveLines = 0;
    let liveTruncated = false;
    let liveBuf = '';

    const child = spawn('/bin/bash', [scriptPath], {
      cwd: CFG.workdir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    currentChild = child;

    const emitLiveLine = (line) => {
      if (liveLines >= CFG.maxLiveLines) {
        if (!liveTruncated) {
          liveTruncated = true;
          log('  . ... (live view truncated; full log: ' + outPath + ')');
        }
        return;
      }
      process.stdout.write('  . ' + line.replace(/\r/g, '') + '\n');
      liveLines++;
    };

    const onData = (buf) => {
      out.write(buf);
      bytes += buf.length;
      liveBuf += buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      let nl;
      while ((nl = liveBuf.indexOf('\n')) >= 0) {
        const line = liveBuf.slice(0, nl);
        liveBuf = liveBuf.slice(nl + 1);
        emitLiveLine(line);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      log('SCRIPT TIMEOUT after ' + CFG.scriptTimeoutMs + 'ms; killing process group');
      killTree(child.pid);
    }, CFG.scriptTimeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (liveBuf) {
        emitLiveLine(liveBuf);
        liveBuf = '';
      }
      currentChild = null;
      out.end(() => {
        let output = '';
        try { output = fs.readFileSync(outPath, 'utf8'); } catch {}
        const exit = signal === 'SIGINT' || signal === 'SIGTERM' ? 130 : (signal ? 124 : (code === null ? 1 : code));
        finishAction(actionId, { exit, signal: signal || null, durationMs: Date.now() - started }, artifactRefs);
        emitEvent('action.finished', {
          kind: 'bash',
          turn,
          actionId,
          exit,
          durationMs: Date.now() - started,
          signal: signal || null,
        });
        resolve({
          exit,
          output,
          durationMs: Date.now() - started,
          bytes,
          runDir: turnDir,
          signal: signal || null,
          git: gitSummary(),
          readHeavy,
          readHint: readHeavy ? readHint(normalized) : '',
        });
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      currentChild = null;
      finishAction(actionId, { exit: 1, error: err.message, durationMs: Date.now() - started }, artifactRefs);
      emitEvent('action.finished', { kind: 'bash', turn, actionId, exit: 1, error: err.message });
      out.end(() => resolve({
        exit: 1,
        output: 'SPAWN ERROR: ' + err.message,
        durationMs: Date.now() - started,
        bytes,
        runDir: turnDir,
        readHeavy,
      }));
    });
  });
}

/* ------------------------------------------------------------- observation */

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function cleanOutput(raw) {
  const text = String(raw || '').replace(ANSI_RE, '');
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r').filter((p) => p.length > 0);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

function clampMiddle(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor((max - 30) / 2);
  return text.slice(0, half) + '\n... (middle omitted) ...\n' + text.slice(-half);
}

function makeObservation(res) {
  const readHeavy = !!res.readHeavy;
  const headN = readHeavy ? CFG.maxReadObsHead : CFG.maxObsHead;
  const tailN = readHeavy ? CFG.maxReadObsTail : CFG.maxObsTail;
  const maxChars = readHeavy ? CFG.maxReadObsChars : CFG.maxObsChars;

  const raw = scrubSecrets(String(res.output || '').replace(ANSI_RE, ''));
  const text = cleanOutput(raw);
  const lines = text.split('\n');
  const head = lines.slice(0, headN).join('\n');
  const tail = lines.slice(-tailN).join('\n');
  const lineCut = lines.length > headN + tailN;

  // If the whole output fits, show ALL of it. The old code always took only
  // the first `headN` lines when it was under the cut threshold, silently
  // hiding lines 26-70 of a 60-line file read.
  let body;
  if (!lineCut) {
    body = text;
  } else {
    body = head + '\n... (' + (lines.length - headN - tailN) + ' lines omitted) ...\n' + tail;
  }

  const charsCut = body.length > maxChars;
  // Keep both ends: the tail usually holds the error that killed the command.
  body = clampMiddle(body, maxChars);

  // Scan every \r/\n segment, not just the cleaned lines: a progress bar that
  // overwrites its own line must not hide the error printed before it.
  const seen = new Set();
  const highlights = [];
  const segments = raw.split(/\r\n|\n|\r/);
  const maxHighlights = readHeavy ? 5 : CFG.maxHighlights;
  for (let i = segments.length - 1; i >= 0 && highlights.length < maxHighlights; i--) {
    const line = segments[i].trim();
    if (!line || seen.has(line)) continue;
    if (!/error|failed|failure|exception|traceback|denied|not found|cannot/i.test(line)) continue;
    seen.add(line);
    highlights.unshift(line);
  }

  if (highlights.length) {
    body += '\n--- highlights ---\n' + clampMiddle(highlights.join('\n'), 3000);
  }

  if (res.git) {
    body += '\n--- git status (working tree) ---\n' + clampMiddle(res.git, 1400);
  }

  if (lineCut || charsCut) {
    const what = lineCut
      ? 'showed ' + headN + ' head + ' + tailN + ' tail of ' + lines.length + ' output lines'
      : 'output exceeded ' + maxChars + ' chars';
    body += '\n[TRUNCATED: ' + what + '.'
      + (res.readHint ? ' Continue with: ' + res.readHint : ' Re-run with a narrower range.')
      + ']';
  }

  return {
    exit: res.exit,
    durationMs: res.durationMs,
    bytes: res.bytes,
    lines: lines.length,
    truncated: lineCut || charsCut,
    headShown: (lineCut || charsCut) ? headN : lines.length,
    tailShown: tailN,
    body: body || '(no output)',
    logPath: path.join(res.runDir, 'output.txt'),
    scriptPath: path.join(res.runDir, 'script.sh'),
    denied: !!res.denied,
    git: res.git || '',
  };
}

function formatObservation(obs) {
  if (!obs) return '(none)';
  return [
    'exit=' + obs.exit + ' | ' + obs.durationMs + 'ms | ' + obs.lines + ' lines',
    'full log: ' + obs.logPath,
    '--- output ---',
    obs.body,
  ].join('\n');
}

function signature(obs) {
  return crypto.createHash('sha1')
    .update(String(obs.exit) + '\n' + obs.body)
    .digest('hex');
}

/* ------------------------------------------------------------------ skills */

let availableSkills = null;
let skillsWorkdir = null;

function parseSkillName(text, fallback) {
  const m = String(text || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (m) {
    const nameLine = m[1].split('\n').find((line) => /^\s*name\s*:/.test(line));
    if (nameLine) {
      const raw = nameLine.replace(/^\s*name\s*:\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (raw && raw.length <= 80 && !/[\r\n\t]/.test(raw)) return raw;
    }
  }
  return fallback;
}

function loadAvailableSkills() {
  if (availableSkills && skillsWorkdir === CFG.workdir) return availableSkills;
  skillsWorkdir = CFG.workdir;
  availableSkills = [];
  const base = path.join(CFG.workdir, '.cursor', 'skills');
  if (!fs.existsSync(base)) return availableSkills;
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return availableSkills; }

  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length >= 200) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === 'SKILL.md') {
        let real;
        try { real = fs.realpathSync(full); } catch { continue; }
        if (!isInside(realBase, real)) continue;
        const rel = path.relative(CFG.workdir, full).split(path.sep).join('/');
        let text = '';
        try { text = fs.readFileSync(full, 'utf8').slice(0, 20000); } catch { continue; }
        const fallback = path.basename(path.dirname(full));
        found.push({
          name: parseSkillName(text, fallback),
          rel,
          file: full,
          content: text.slice(0, 12000),
        });
      }
    }
  };
  walk(base, 0);

  const counts = {};
  for (const s of found) counts[s.name] = (counts[s.name] || 0) + 1;
  for (const s of found) {
    s.label = counts[s.name] > 1 ? s.name + ' (' + s.rel + ')' : s.name;
  }
  found.sort((a, b) => (a.name === b.name ? a.rel.localeCompare(b.rel) : a.name.localeCompare(b.name)));
  availableSkills = found;
  return availableSkills;
}

function refreshSkills() {
  availableSkills = null;
  skillsWorkdir = null;
  return loadAvailableSkills();
}

function findSkill(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const list = loadAvailableSkills();
  return list.find((s) => s.label.toLowerCase() === wanted)
    || list.find((s) => s.name.toLowerCase() === wanted)
    || null;
}

function skillsForGoal(goal) {
  const text = String(goal || '').toLowerCase();
  return loadAvailableSkills()
    .filter((s) => {
      const name = s.name.toLowerCase();
      return name && new RegExp('(^|[^a-z0-9_.-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9_.-]|$)').test(text);
    })
    .map((s) => s.name);
}

function skillsPromptBlock() {
  const list = loadAvailableSkills();
  const lines = ['AVAILABLE SKILLS'];
  if (!list.length) {
    lines.push('(none)');
  } else {
    for (const s of list) lines.push('- ' + s.label);
    lines.push('To load a skill, reply with a bash block whose first line is: # skill: <name>');
  }
  return lines.join('\n');
}

function selectedSkillsBlock() {
  const names = Array.isArray(state && state.selectedSkills) ? state.selectedSkills : [];
  if (!names.length) return '';
  const parts = [];
  for (const name of [...new Set(names)]) {
    const skill = findSkill(name);
    if (!skill) continue;
    parts.push('SKILL: ' + skill.label + ' (' + skill.rel + ')');
    parts.push(skill.content.trim());
  }
  return parts.length ? 'SELECTED SKILL CONTENT\n' + parts.join('\n\n') : '';
}

function requestedSkill(script) {
  const m = String(script || '').match(/^\s*#\s*skill\s*:\s*(.+)$/im);
  return m ? m[1].trim() : '';
}

/* ----------------------------------------------------------------- prompt */

function languageLine() {
  if (/^(vi|vn)/i.test(CFG.lang || '')) {
    return 'LANGUAGE: Vietnamese (tiếng Việt) for # note, DONE/BLOCKED summaries, progress text and review findings. '
      + 'Keep shell commands, code, file paths, JSON keys and protocol words unchanged.';
  }
  return 'LANGUAGE: ' + (CFG.lang || 'en') + '. Keep code and protocol words unchanged.';
}

function buildPrompt() {
  const now = new Date();
  const date = now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
  const review = state.mode === 'review';

  const p = [];
  p.push('GOAL: ' + state.goal);
  p.push('');
  p.push('You are an autonomous terminal agent. You act only by writing ONE bash script per reply.');
  p.push('WORKDIR: ' + CFG.workdir);
  p.push('ENV: ' + process.platform + ' ' + process.arch + ' | bash'
    + (state.gitBranch ? ' | git ' + state.gitBranch : ''));
  p.push('DATE: ' + date);
  p.push(languageLine());
  const invocationUsed = state.turn - (state.invocationStartTurn || 0);
  p.push('TURN: ' + invocationUsed + '/' + CFG.maxTurns
    + ' this invocation (total ' + state.turn + ')');
  p.push('MODE: ' + (review ? 'REVIEW (read-only)' : 'BUILD'));
  p.push('');
  p.push(skillsPromptBlock());
  const skillContent = selectedSkillsBlock();
  if (skillContent) {
    p.push('');
    p.push(skillContent);
  }
  p.push('');
  p.push('HOW TO REPLY');
  p.push('- Work remains: reply with exactly ONE fenced code block containing a bash script.');
  p.push('- Nothing outside the block. No questions. No commentary. No second block.');
  p.push('- Always open the block with ```bash, including for DONE/BLOCKED/ATTACH.');
  p.push('  Put the protocol word on the first line INSIDE the block, never as the fence language.');
  p.push('- For every bash block, make the first line a single short comment:');
  p.push('  # note: <what you are about to do and why, max 120 chars>');
  p.push('  The harness shows this comment in its UI before running the commands.');
  p.push('- Optional second comment line when the direction changes:');
  p.push('  # progress: {"milestone":"short name","changeReason":"why it changed"}');
  p.push('  Valid JSON only; both fields are optional. The harness ignores malformed metadata.');

  if (review) {
    p.push('- DEPTH OVER BREADTH: read the implementation, not just file names.');
    p.push('  A directory listing, import list, or grep hit is NOT evidence.');
    p.push('- BATCH 2-4 targeted reads per script, not ten directory listings.');
    p.push('- Keep total read output per script under ~140 lines; split larger batches.');
    p.push('- Files > 200 lines: read in chunks with sed -n "A,Bp"; continue at B+1.');
    p.push('- Do not edit project source files. You may run read-only commands and tests.');
    p.push('  Write only .harness/PLAN.md, .harness/NOTES.md, .harness/REVIEW.md.');
    p.push('- Every finding needs evidence: path:line or path:from-to.');
    p.push('- Cite only lines listed in READ COVERAGE; re-read the range if needed.');
    p.push('- List every scope file you did not read under "## Unverified", with why.');
    p.push('- If an observation says TRUNCATED, read the suggested next range before concluding.');
    p.push('- DONE only when .harness/REVIEW.md has Scope, Files read, Findings');
    p.push('  (>=2 path:line citations), Risks, Unverified, Recommendation, and no TODO/TBD.');
  } else {
    p.push('- Up to 10 commands per script. They run in one shell, in WORKDIR.');
    p.push('- BATCH independent work. Mechanical tasks (inspect, install, edit, build, test)');
    p.push('  belong in ONE script. Split only when a later command needs this output to decide.');
    p.push('- Do not spend a whole turn on a single trivial command.');
    p.push('- If an observation says TRUNCATED, read the next range before concluding.');
    p.push('- Keep output small. Pipe verbose commands through tail -n 40.');
  }

  p.push('- Goal complete: reply with ONE fenced block whose first line is exactly DONE,');
  p.push('  then a 3-6 line summary.');
  p.push('- Blocked on a human decision, credential, or access you do not have: reply with ONE');
  p.push('  fenced block whose first line is exactly BLOCKED, then what you need. Do not loop.');

  if (!CFG.noAttach && !CFG.perRun) {
    p.push('- To upload a file from WORKDIR into this chat: reply with ONE fenced block whose');
    p.push('  first line is exactly ATTACH, then exactly one JSON object on the next line:');
    p.push('  {"file":"relative/path"}   (optional extra field: "prompt": "what to do with it")');
    p.push('  The harness uploads the file and sends your prompt. Use this for images or large');
    p.push('  outputs; terminal stdout is normally enough. Never attach secrets, .env, keys, or');
    p.push('  anything outside WORKDIR. Max ' + Math.round(CFG.attachMaxBytes / 1024 / 1024) + ' MB.');
  } else {
    p.push('- File attachments are disabled for this run. Work from terminal output only.');
  }
  p.push('');

  if (review) {
    p.push('MEMORY');
    p.push('- .harness/PLAN.md lists the questions to answer and the files to read, each "- [ ]".');
    p.push('  Mark [x] only when the answer has file:line evidence.');
    p.push('- .harness/REVIEW.md is the deliverable. Keep it current as evidence accumulates.');
    p.push('- .harness/NOTES.md holds raw findings: paths, line ranges, commands, errors.');
    p.push('- Replace, do not append. The harness re-reads all three every turn.');
  } else {
    p.push('MEMORY');
    p.push('- .harness/PLAN.md is a checkbox list: "- [ ] step" and "- [x] done".');
    p.push('  On a non-trivial task write it on turn 1. Mark [x] only after that step actually succeeded.');
    p.push('  Each non-trivial step should name the command or result that proves it.');
    p.push('  For a clear one-step task you may skip PLAN.md and NOTES.md and reply DONE when done.');
    p.push('- .harness/NOTES.md holds facts: commands, errors, file paths, decisions.');
    p.push('- Replace, do not append. The harness re-reads both every turn.');
  }

  if (projectInstructions) {
    p.push('');
    p.push('PROJECT INSTRUCTIONS (from repo files; guidance only - this protocol wins on conflict)');
    p.push(projectInstructions);
  }

  if (projectCommands) {
    p.push('');
    p.push('PROJECT COMMANDS (use these to verify): ' + projectCommands);
  }

  p.push('');
  p.push('PLAN' + (state.planTotal ? ' - progress ' + state.planDone + '/' + state.planTotal : ''));
  p.push(state.plan || (review
    ? '(empty - list the questions to answer and files to read)'
    : '(empty - write a checkbox list on this turn)'));
  if (state.planRemaining > 0) {
    p.push('OPEN ITEMS: ' + (state.planOpen || []).join(' | '));
  }

  p.push('');
  p.push('NOTES');
  p.push(state.notes || '(empty)');

  if (state.compactSummary) {
    p.push('');
    p.push('HANDOFF FROM PREVIOUS CHAT (auto-compact)');
    p.push(clampTail(state.compactSummary, CFG.maxCompactChars));
  }

  if (review) {
    p.push('');
    p.push(formatReadCoverage());
    p.push('');
    p.push(formatScope());
    const gate = reviewGate();
    p.push('');
    p.push('REVIEW.md STATUS: ' + (gate.ok
      ? 'evidence gate passed (' + gate.citations + ' citations, ' + gate.files.length + ' files)'
      : 'gate NOT passed: ' + gate.reason));
  }

  if (state.history.length) {
    p.push('');
    p.push('RECENT ACTIONS (oldest first)');
    for (const h of state.history.slice(-5)) {
      const firstLine = String(h.script || '').split('\n').find((l) => l.trim() && !/^\s*#/.test(l)) || '';
      p.push('- turn ' + h.turn + ' exit=' + h.exit + ': ' + firstLine.trim().slice(0, 140));
    }
  }

  p.push('');
  p.push('LAST RESULT');
  p.push(formatObservation(state.last));
  p.push('');
  p.push('RULES');
  p.push('- Never repeat a command that already succeeded.');
  if (CFG.safeMode) {
    p.push('- No sudo. No deleting outside WORKDIR. No curl piped into a shell.');
  }
  p.push('- Never print secrets: no ~/.ssh, no .env values, no tokens.');
  p.push('- Do not use Copilot web search or browsing. Use terminal commands (npm view, git, curl).');
  p.push('- Do not write to an output file. The harness captures stdout and stderr.');
  p.push('- If a command failed, read the error and fix the cause before moving on.');
  p.push('- git status shows the whole tree, including pre-existing user changes.');
  p.push('  Fix accidental edits you made, but never revert changes you did not make.');

  if (review) {
    p.push('- Do not modify project source files; only .harness/*.md may be written.');
    p.push('- Do not claim a file is reviewed unless it is in READ COVERAGE with the relevant lines.');
    p.push('- Do not answer from file names, imports, or a directory listing.');
  } else {
    p.push('- Before DONE, run the relevant PROJECT COMMAND once, unless there is nothing to verify.');
    p.push('- Do not re-run verification a previous turn already did.');
    p.push('- Near the end, stop exploring: finish, verify once, then DONE.');
  }

  if (state.forceChange) {
    p.push('');
    p.push('WARNING: the last 3 results were identical. Change approach or explain why you are stuck.');
  }

  const turnsLeft = CFG.maxTurns - state.turn;
  if (turnsLeft <= 8) {
    p.push('');
    p.push('TURN BUDGET: only ' + turnsLeft + ' turns left. Finish the goal or report what blocks it.');
  }

  const preReset = state.turn > 0 && (state.turn + 1) % CFG.resetAfterTurns === 0;
  const periodic = state.turn > 0
    && state.turn % CFG.checkpointEvery === 0
    && state.turn % CFG.resetAfterTurns !== 0;

  if (preReset || periodic) {
    p.push('');
    p.push('CHECKPOINT: context is getting long. Rewrite both files from scratch now,');
    p.push('so a brand new session could continue from them alone. Terse bullets; never drop a section.');
    p.push('PLAN.md: the goal, then "- [ ]" / "- [x]" steps, then the single next step.');
    p.push('NOTES.md sections: Goal, Done, Current state, Files touched, Commands and results,');
    p.push('Errors and fixes, Constraints and decisions, Next step. Write "(none)" for empty sections.');
    p.push('Keep PLAN.md under ' + CFG.maxPlanChars + ' chars and NOTES.md under '
      + CFG.maxNotesChars + '. Replace, do not append.');
    if (review) {
      p.push('For REVIEW: include files read with line ranges, answered questions, unread files,');
      p.push('and claims that remain UNVERIFIED. Keep REVIEW.md consistent with PLAN.md.');
    }
  }

  if (state.planOversize || state.notesOversize) {
    p.push('');
    p.push('MEMORY WARNING: PLAN.md or NOTES.md exceeded its size limit and was trimmed.');
    p.push('Rewrite it shorter this turn.');
  }

  return p.join('\n');
}

function buildFinalPrompt() {
  return buildPrompt() + '\n\n'
    + 'FINAL TURN (action budget used)\n'
    + '- You may NOT run more commands or attach files in this invocation.\n'
    + '- Reply with exactly ONE fenced block whose first line is DONE + summary if the goal is complete.\n'
    + '- Or BLOCKED + what you need from the user.\n'
    + '- Any bash script or ATTACH here stops the run as partial and keeps the last result.';
}

/* ------------------------------------------------------------------- chat */

function isCopilotUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'copilot.com' || host.endsWith('.copilot.com')
      || host === 'copilot.microsoft.com' || host.endsWith('.copilot.microsoft.com')
      || host === 'copilot.cloud.microsoft' || host.endsWith('.copilot.cloud.microsoft')
      || host === 'm365.cloud.microsoft' || host.endsWith('.m365.cloud.microsoft');
  } catch {
    return false;
  }
}

function allPages(browser) {
  const pages = [];
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      if (!pg.isClosed()) pages.push(pg);
    }
  }
  return pages;
}

async function composerVisibleInPage(page) {
  try {
    for (const sel of SEL.composer) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function pageHost(page) {
  try { return new URL(page.url()).hostname.toLowerCase(); } catch { return ''; }
}

async function waitForAnyComposer(browser, timeoutMs, why) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  let wanted = '';
  try { wanted = new URL(CFG.chatUrl).hostname.toLowerCase(); } catch {}

  while (Date.now() < deadline) {
    const pages = allPages(browser);
    const copilot = pages.filter((pg) => isCopilotUrl(pg.url()));
    copilot.sort((a, b) => {
      return (pageHost(a) === wanted ? 0 : 1) - (pageHost(b) === wanted ? 0 : 1);
    });

    for (const pg of copilot) {
      if (await composerVisibleInPage(pg)) {
        await pg.bringToFront().catch(() => {});
        return pg;
      }
    }

    if (Date.now() - lastLog > 15000) {
      log('WAITING: ' + (why || 'Copilot composer') + ' (sign in in the Edge window if asked)');
      log('  pages: ' + pages.map((p) => p.url()).join(' | ').slice(0, 600));
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function findCopilotPage(browser) {
  const pages = allPages(browser).filter((pg) => isCopilotUrl(pg.url()));
  if (pages.length) {
    let wanted = '';
    try { wanted = new URL(CFG.chatUrl).hostname.toLowerCase(); } catch {}
    const exact = pages.filter((pg) => pageHost(pg) === wanted);
    const pool = exact.length ? exact : pages;

    // A Copilot tab can exist while another tab sits on the Microsoft login.
    // Prefer the tab that actually has a composer.
    for (const pg of pool) {
      if (await composerVisibleInPage(pg)) return pg;
    }
    return pool[pool.length - 1];
  }

  const contexts = browser.contexts();
  const ctx = contexts.length ? contexts[0] : await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(CFG.chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

/*
 * Auto-compact handoff: ask the CURRENT chat to write a handoff summary
 * (COMPACT reply), so the next chat can be seeded with it. Nothing is
 * executed here; a non-COMPACT reply is ignored and we fall back to the
 * on-disk memory (PLAN/NOTES), which is already self-contained.
 */
async function requestCompact(page) {
  const prompt = [
    'CONTEXT COMPACT: this conversation is getting long.',
    'The harness is about to open a NEW Copilot chat and will seed it with your handoff.',
    'Reply with exactly ONE fenced block. Open it with ```bash.',
    'First line INSIDE the block: COMPACT',
    'Then a handoff summary for the next chat:',
    '- Goal and what is already done',
    '- Current state and the single next step',
    '- Key file paths, commands that worked, pitfalls',
    'Max ~30 lines. Do not run commands. Do not reply DONE.',
    languageLine(),
    '',
    skillsPromptBlock(),
  ].join('\n');

  let reply;
  try {
    const before = await sendPrompt(page, prompt);
    reply = await waitForReply(page, before, Date.now() + CFG.maxTurnMs);
  } catch {
    return { ok: false, summary: '' };
  }
  if (!reply || reply.kind !== 'block') {
    await dumpPage(page, 'compact-no-block');
    return { ok: false, summary: '' };
  }

  const parsed = parseReply(reply.text);
  if (parsed.kind !== 'compact') {
    await dumpPage(page, 'compact-bad-reply');
    return { ok: false, summary: '' };
  }
  emitEvent('context.compacted', { turn: state ? state.turn : 0, chars: (parsed.summary || '').length });
  return { ok: true, summary: parsed.summary || '' };
}

async function resetChat(page) {
  log('RESET: starting a fresh Copilot chat');
  const btn = await firstVisible(page, SEL.newChat, 2500);
  if (btn) {
    await btn.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(800);
  } else {
    // Navigating to the base URL usually drops the conversation; if Copilot
    // restores it, the next prompt is still self-contained, so this is safe.
    await page.goto(CFG.chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await firstVisible(page, SEL.composer, 30000);
  await page.waitForTimeout(500);
}

/* ------------------------------------------------------------ edge launcher */

function findEdgeExecutable() {
  if (CFG.edgeBin && fs.existsSync(CFG.edgeBin)) return CFG.edgeBin;

  const candidates = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  for (const name of ['microsoft-edge', 'microsoft-edge-stable', 'msedge']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

async function cdpVersion(base, timeoutMs = 1500) {
  try {
    const res = await fetch(String(base).replace(/\/+$/, '') + '/json/version', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForCdp(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const v = await cdpVersion(base, 1200);
    if (v) return v;
    if (Date.now() - lastLog > 5000) {
      log('WAITING: Edge CDP at ' + base + ' ...');
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let mockEdgePid = null;
let mockProfileDir = null;

function cleanupMock() {
  if (mockEdgePid) {
    killTree(mockEdgePid);
    mockEdgePid = null;
  }
  if (mockProfileDir) {
    try { fs.rmSync(mockProfileDir, { recursive: true, force: true }); } catch {}
    mockProfileDir = null;
  }
}

async function startMock() {
  const edge = findEdgeExecutable();
  if (!edge) {
    throw new HarnessError('no_edge',
      'Microsoft Edge not found. Install Edge or set EDGE_BIN=/path/to/edge.');
  }
  const html = path.join(__dirname, 'mock', 'copilot.html');
  if (!fs.existsSync(html)) {
    throw new HarnessError('no_mock', 'Missing mock page: ' + html);
  }

  const port = await getFreePort();
  mockProfileDir = path.join(os.tmpdir(), 'copilot-harness-mock-' + process.pid);
  fs.mkdirSync(mockProfileDir, { recursive: true });
  const url = pathToFileURL(html).href;

  const args = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + mockProfileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1400,900',
    url,
  ];
  const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
  child.unref();
  mockEdgePid = child.pid;
  process.once('exit', cleanupMock);

  CFG.cdp = 'http://127.0.0.1:' + port;
  CFG.chatUrl = url;
  CFG.mock = true;

  const v = await waitForCdp(CFG.cdp, 30000);
  if (!v) {
    cleanupMock();
    throw new HarnessError('mock_cdp', 'Headless Edge did not expose CDP on port ' + port);
  }
  log('MOCK: headless Edge ' + v.Browser + ' on ' + CFG.cdp);
}

async function launchEdge() {
  if (await cdpVersion(CFG.cdp)) return false;
  const edge = findEdgeExecutable();
  if (!edge) {
    throw new HarnessError('no_edge',
      'Microsoft Edge not found. Install Edge or set EDGE_BIN=/path/to/edge.');
  }
  fs.mkdirSync(CFG.profileDir, { recursive: true });
  let port = '9222';
  try { port = new URL(CFG.cdp).port || port; } catch {}
  log('LAUNCH: ' + edge);
  log('PROFILE: ' + CFG.profileDir);
  const child = spawn(edge, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + CFG.profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    CFG.chatUrl,
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  const v = await waitForCdp(CFG.cdp, 45000);
  if (!v) {
    throw new HarnessError('cdp_launch',
      'Edge did not expose CDP at ' + CFG.cdp + '. Close any Edge window using '
      + CFG.profileDir + ' and try again (or launch Edge manually with '
      + '--remote-debugging-port=' + port + ' --user-data-dir=<dir>).');
  }
  return true;
}

async function waitForComposer(page, timeoutMs, why) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const composer = await firstVisible(page, SEL.composer, 1500);
    if (composer) return true;
    if (Date.now() - lastLog > 15000) {
      log('WAITING: ' + (why || 'Copilot composer') + ' (sign in in the Edge window if asked)');
      lastLog = Date.now();
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function findMockPage(browser) {
  const contexts = browser.contexts();
  const ctx = contexts.length ? contexts[0] : await browser.newContext();
  let page = ctx.pages().find((p) => p.url().startsWith('file:'));
  if (!page) page = ctx.pages()[0];
  if (!page) page = await ctx.newPage();
  if (!page.url().startsWith('file:')) {
    await page.goto(CFG.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.bringToFront();
  await waitForComposer(page, 15000, 'mock composer');

  // Tests can script replies from a JSON file. Each entry is either a reply
  // string or {reply}. After the list is exhausted, fallback is used.
  const repliesPath = process.env.HARNESS_MOCK_REPLIES;
  if (repliesPath) {
    const parsed = JSON.parse(fs.readFileSync(repliesPath, 'utf8'));
    await page.evaluate((data) => { window.__mockReplies = data; }, parsed);
  }
  return page;
}

/* ------------------------------------------------------------- json result */

function emitResult(obj) {
  CFG.terminalEmitted = true;
  if (!CFG.json) return;
  try {
    const base = {
      at: new Date().toISOString(),
      runId: CFG.runId || null,
      mode: CFG.mode,
      ...obj,
    };
    if (!('exitCode' in base)) base.exitCode = exitCodeForStatus(base.status);
    process.stdout.write('\n__HARNESS_RESULT__' + JSON.stringify(base) + '\n');
  } catch {}
}

/* ------------------------------------------------------------------- loop */

async function runGoal(page, goal, opts = {}) {
  if (!opts.resume) {
    const previous = loadState();
    if (previous && (previous.goal !== goal || previous.done || previous.blocked)) {
      fs.mkdirSync(memoryDir(), { recursive: true });
      archiveMemory();
    }
    state = newState(goal);
    ensureMemory();
    saveState();
  } else {
    const loaded = loadState(true);
    if (!loaded) throw new HarnessError('no_session', 'Nothing to continue: session.json not found.');
    state = migrateSession(loaded);
    if (state.status === 'done' || (state.done === true && state.partial !== true)) {
      const err = new HarnessError('already_done', 'The last goal is already DONE. Start a new goal instead of --continue.');
      err.turns = state.turn || 0;
      throw err;
    }
    state.nudges = 0;
    state.forceChange = false;
    state.blocked = false;
    state.status = 'running';
    state.done = false;
    delete state.doneAt;
    state.history = Array.isArray(state.history) ? state.history : [];
    state.recent = Array.isArray(state.recent) ? state.recent : [];
    state.mode = state.mode || detectMode(state.goal);
    if (CFG.readonly) state.mode = 'review';
    state.reads = state.reads && typeof state.reads === 'object' ? state.reads : {};
    state.readOrder = Array.isArray(state.readOrder) ? state.readOrder : [];
    state.scope = Array.isArray(state.scope) ? state.scope : [];
    state.reviewNudges = state.reviewNudges || 0;
    state.lastScriptCanon = state.lastScriptCanon
      || (state.lastScript ? canonicalScript(state.lastScript) : '');
    delete state.lastScript;
    state.doneNudged = !!state.doneNudged;
    ensureMemory();
  }

  if (!CFG.reviewExplicit && CFG.reviewMode === 'off' && state.reviewMode && state.reviewMode !== 'off') {
    CFG.reviewMode = state.reviewMode;
  }
  if (!opts.resume) {
    if (/\[review-required\]/i.test(state.goal)) CFG.reviewMode = 'required';
    else if (CFG.reviewMode === 'off' && /\[review\]/i.test(state.goal)) CFG.reviewMode = 'optional';
  }
  state.reviewMode = CFG.reviewMode;
  state.invocationStartTurn = state.turn;
  state.verifyNudges = 0;
  verificationApproved = false;
  CFG.terminalEmitted = false;
  state.review = (state.review && typeof state.review === 'object') ? state.review : {};
  state.review.attempts = 0;
  state.review.fixRounds = 0;
  refreshSkills();
  state.selectedSkills = Array.isArray(state.selectedSkills) ? state.selectedSkills : [];
  for (const name of skillsForGoal(state.goal)) {
    if (!state.selectedSkills.includes(name)) state.selectedSkills.push(name);
  }
  if (!verificationSpec) resolveVerificationForState(state);
  saveState();

  syncMemory();
  state.gitBranch = gitBranch();
  if (state.mode === 'review' && (!state.scope || !state.scope.length)) {
    state.scope = extractScope(state.goal);
    if (state.scope.length) log('review scope: ' + state.scope.length + ' files');
  }
  try { snapshotGit(); } catch {}

  log('');
  log('=== GOAL: ' + state.goal);
  log('=== turn ' + state.turn + ', invocation budget ' + CFG.maxTurns);

  try { state.chatUrl = page.url(); saveState(); } catch {}
  emitEvent('run.started', {
    goal: state.goal,
    mode: CFG.mode,
    turn: state.turn,
    maxTurns: CFG.maxTurns,
    chatUrl: state.chatUrl || '',
    workspace: CFG.workdir,
    verification: verificationSpec ? { specPath: verificationSpec.path, specHash: verificationSpec.hash } : null,
    progress: {
      direction: state.progress.direction || '',
      milestone: state.progress.milestone || '',
      phase: 'preparing',
    },
  });
  emitPhase('preparing', {
    goal: state.goal,
    direction: state.progress.direction || '',
    provider: CFG.mock ? 'mock' : 'edge-copilot',
  });
  if (state.progress.lastVerification) {
    emitEvent('progress.verification', state.progress.lastVerification);
  }

  let sendMs = 0;
  let promptChars = 0;
  let lastFreshTurn = -1;
  const send = async (promptText) => {
    // --per-run: a new chat for every executed turn. The prompt is fully
    // self-contained, so losing the chat history costs nothing except the
    // (already bounded) plan/notes, which are re-injected from disk.
    if (CFG.perRun && !CFG.mock && state.turn > 0 && state.turn !== lastFreshTurn) {
      await resetChat(page);
      lastFreshTurn = state.turn;
    }
    let text = String(promptText);
    // Every provider prompt carries the full skill list exactly once,
    // including format/retry nudges that do not call buildPrompt().
    if (!text.includes('AVAILABLE SKILLS')) text += '\n\n' + skillsPromptBlock();
    const t0 = Date.now();
    promptChars = text.length;
    const b = await sendPrompt(page, text);
    sendMs = Date.now() - t0;
    emitEvent('provider.waiting', { turn: state.turn + 1, promptChars });
    emitPhase('waiting', {
      provider: CFG.mock ? 'mock' : 'edge-copilot',
      promptChars,
      turn: state.turn + 1,
    });
    return b;
  };

  const started = Date.now();
  const startTurn = state.turn;
  let finalTurn = false;
  let finished = false;

  const finishGoal = (result) => {
    if (finished) return result;
    finished = true;
    CFG.terminalEmitted = true;
    let final = terminalResult(result.status, result);

    if (final.status === 'done') {
      state.done = true;
      state.doneAt = state.doneAt || Date.now();
      state.partial = false;
    } else {
      state.done = false;
      delete state.doneAt;
      if (final.status === 'partial') state.partial = true;
      if (final.status === 'blocked') state.blocked = true;
      else state.blocked = false;
    }
    state.status = final.status;
    if (final.summary) state.summary = final.summary;
    state.lastResult = { ...final, at: Date.now() };

    // Finalize order: compute status -> persist checkpoint -> emit result.
    let saved = false;
    try {
      saveState('finalize');
      saved = true;
    } catch (e) {
      log('ERROR: checkpoint write failed at finalize: ' + e.message);
      final = terminalResult('error', {
        status: 'error',
        reason: 'checkpoint_write_failed: ' + e.message,
        code: 'checkpoint_write_failed',
        summary: 'Không thể ghi checkpoint; lần chạy này không có resume.',
        canResume: false,
        turns: final.turns,
        verification: final.verification,
      });
      state.status = 'error';
      state.done = false;
      delete state.doneAt;
      state.partial = false;
      state.lastResult = { ...final, at: Date.now() };
      try { saveState(); } catch {}
    }

    // Never advertise a resume that was not confirmed on disk.
    if (saved) {
      try {
        const disk = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
        if (disk.status !== final.status) throw new Error('status mismatch');
      } catch (e) {
        final = {
          ...final,
          canResume: false,
          reason: final.reason || ('checkpoint not confirmed: ' + e.message),
        };
      }
    }

    emitEvent('run.finished', {
      status: final.status,
      turns: final.turns,
      reason: final.reason || final.summary || '',
      canResume: final.canResume === true,
      exitCode: final.exitCode,
      verification: final.verification,
      review: final.review,
      artifactPaths: final.artifactPaths,
    });
    return final;
  };

  const interrupted = startedActions(state);
  if (interrupted.length) {
    const inspection = interrupted.map((a) => ({
      id: a.id,
      kind: a.kind,
      turn: a.turn,
      startedAt: a.startedAt || null,
      script: a.script ? String(a.script).slice(0, 400) : undefined,
      file: a.file || undefined,
    }));
    log('');
    log('BLOCKED: resume_inspection_required');
    for (const a of inspection) {
      log('  action #' + a.id + ' · ' + a.kind + ' · turn ' + a.turn
        + (a.script ? ' · ' + a.script.split('\n')[0] : ''));
    }
    return finishGoal({
      status: 'blocked',
      reason: 'resume_inspection_required',
      summary: 'Checkpoint có action đã bắt đầu nhưng chưa có kết quả. '
        + 'Kiểm tra workspace rồi đánh dấu finished hoặc xoá action khỏi session trước khi /continue.',
      turns: state.turn,
      canResume: false,
      inspection: { actions: inspection },
      verification: currentVerification(),
    });
  }

  let before;
  try {
    before = await send(buildPrompt());

    while (true) {
      if (state.turn - startTurn >= CFG.maxTurns && !finalTurn) {
        finalTurn = true;
        log('TURN BUDGET: action budget used; allowing one final DONE/BLOCKED turn');
        before = await send(buildFinalPrompt());
        continue;
      }
      if (Date.now() - started > CFG.maxTotalMs) {
        return finishGoal({
          status: 'timed_out',
          reason: 'total time budget reached',
          turns: state.turn,
          canResume: true,
          verification: currentVerification(),
        });
      }

    let reply;
    let waitMs = 0;
    try {
      const waitStarted = Date.now();
      reply = await waitForReply(page, before, Date.now() + CFG.maxTurnMs);
      waitMs = Date.now() - waitStarted;
    } catch (e) {
      if (e.code !== 'turn_timeout') throw e;
      if (finalTurn) {
        return finishGoal({
          status: 'partial',
          reason: 'no reply on final turn',
          turns: state.turn,
          canResume: true,
          summary: 'Chưa hoàn tất: Copilot không trả lời ở lượt kết thúc. /continue để tiếp tục.',
          verification: currentVerification(),
        });
      }

      state.nudges++;
      saveState();
      if (state.nudges > 2) {
        throw new HarnessError('no_reply', 'Copilot never produced a usable block after 3 attempts.');
      }

      await dumpPage(page, 'turn-' + (state.turn + 1) + '-timeout');
      log('WARN: no reply block. Nudging (' + state.nudges + '/3)');
      before = await send(
        'FORMAT ERROR: reply with exactly ONE fenced block.\n' +
        'Open it with ```bash and start a bash script with: # note: <what you will do>\n' +
        'If finished its first line must be DONE. No prose outside the block.'
      );
      continue;
    }

    if (reply.kind === 'prose') {
      if (finalTurn) {
        return finishGoal({
          status: 'partial',
          reason: 'final turn did not return DONE or BLOCKED',
          turns: state.turn,
          canResume: true,
          summary: 'Chưa hoàn tất: lượt kết thúc không trả DONE/BLOCKED. /continue để tiếp tục.',
          verification: currentVerification(),
        });
      }
      state.nudges++;
      saveState();
      if (state.nudges > 2) {
        throw new HarnessError('no_block', 'Copilot replied without a fenced block 3 times.');
      }
      await dumpPage(page, 'turn-' + (state.turn + 1) + '-prose');
      log('WARN: reply had no fenced block. Nudging (' + state.nudges + '/3)');
      before = await send(
        'FORMAT ERROR: your reply contained no fenced code block.\n' +
        'Reply with exactly ONE ```bash block. Start a bash script with: # note: <what you will do>\n' +
        'If finished, its first line must be DONE. No prose outside the block.'
      );
      continue;
    }

    state.nudges = 0;
    const parsed = parseReply(reply.text);

    if (finalTurn && parsed.kind !== 'done' && parsed.kind !== 'blocked') {
      saveState();
      return finishGoal({
        status: 'partial',
        reason: 'turn budget reached (' + CFG.maxTurns + '); final turn only accepts DONE or BLOCKED',
        turns: state.turn,
        canResume: true,
        summary: 'Chưa hoàn tất: hết ngân sách action, lượt kết thúc chỉ nhận DONE/BLOCKED. /continue để tiếp tục.',
        verification: currentVerification(),
      });
    }

    if (parsed.kind === 'empty') {
      state.nudges++;
      saveState();
      if (state.nudges > 2) throw new HarnessError('empty_reply', 'Empty replies three times.');
      before = await send('Your previous reply was empty. Reply with exactly ONE fenced block.');
      continue;
    }

    if (parsed.kind === 'attach') {
      if (CFG.noAttach || CFG.perRun) {
        state.nudges++;
        saveState();
        if (state.nudges > 2) throw new HarnessError('attach_disabled', 'Copilot kept trying to attach files while attachments are disabled.');
        log('WARN: ATTACH rejected (attachments disabled)');
        before = await send(
          'ATTACH is disabled for this run. Reply with exactly ONE fenced block:\n' +
          'a bash script if work remains, or DONE if the goal is complete.'
        );
        continue;
      }

      let file;
      try {
        file = resolveAttachment(parsed.payload && parsed.payload.file);
      } catch (e) {
        state.nudges++;
        saveState();
        if (state.nudges > 2) throw new HarnessError(e.code || 'attach_failed', e.message);
        log('WARN: ATTACH failed: ' + e.message);
        before = await send(
          'ATTACH REJECTED: ' + e.message + '\n' +
          'Fix the path (it must be a regular file inside WORKDIR and not a secret), ' +
          'or continue with a bash script / DONE. Reply with exactly ONE fenced block.'
        );
        continue;
      }

      const actionId = nextActionId();
      const attachNote = parsed.payload && typeof parsed.payload.prompt === 'string'
        ? parsed.payload.prompt.trim()
        : 'Gửi ' + file.rel;
      emitIntent(attachNote, {}, state.turn + 1, actionId);
      emitEvent('action.proposed', {
        kind: 'attach',
        turn: state.turn + 1,
        actionId,
        file: file.rel,
        bytes: file.size,
        workspace: CFG.workdir,
      });
      const approval = await requestApproval('attach', { file: file.rel, bytes: file.size }, actionId);
      if (!approval.approve) {
        state.nudges++;
        saveState();
        if (state.nudges > 2) throw new HarnessError('attach_denied', 'Attach was denied three times.');
        log('WARN: ATTACH denied by user (' + (approval.reason || '') + ')');
        emitEvent('action.finished', { kind: 'attach', turn: state.turn + 1, actionId, denied: true, reason: approval.reason });
        before = await send(
          'ATTACH DENIED BY USER (' + (approval.reason || 'no reason') + '). '
          + 'Continue with a bash script or DONE. Reply with exactly ONE fenced block.'
        );
        continue;
      }

      // Re-check immediately before the side effect, including this branch.
      if (state.turn - startTurn >= CFG.maxTurns) {
        return finishGoal({
          status: 'partial',
          reason: 'turn budget reached (' + CFG.maxTurns + ') before attach',
          turns: state.turn,
          canResume: true,
          summary: 'Chưa hoàn tất: hết ngân sách action trước khi upload. /continue để tiếp tục.',
          verification: currentVerification(),
        });
      }

      beginAction(actionId, 'attach', state.turn + 1, {
        file: file.rel,
        bytes: file.size,
      });

      try {
        await uploadAttachment(page, file.abs);
      } catch (e) {
        finishAction(actionId, { exit: 1, error: e.message });
        emitEvent('action.finished', { kind: 'attach', turn: state.turn + 1, actionId, exit: 1, error: e.message });
        state.nudges++;
        saveState();
        if (state.nudges > 2) throw new HarnessError(e.code || 'attach_failed', e.message);
        log('WARN: ATTACH failed: ' + e.message);
        before = await send(
          'ATTACH REJECTED: ' + e.message + '\n' +
          'or continue with a bash script / DONE. Reply with exactly ONE fenced block.'
        );
        continue;
      }

      state.nudges = 0;
      state.turn++;
      state.history.push({
        turn: state.turn,
        script: 'ATTACH ' + file.rel,
        exit: 0,
        head: file.size + ' bytes',
      });
      if (state.history.length > 50) state.history.shift();
      finishAction(actionId, { exit: 0, file: file.rel, bytes: file.size });
      saveState();
      log('');
      log('--- turn ' + state.turn + ' ---');
      log('attached: ' + file.rel + ' (' + file.size + ' bytes)');
      emitEvent('action.finished', { kind: 'attach', turn: state.turn, actionId, file: file.rel, bytes: file.size, exit: 0 });

      const extra = parsed.payload && typeof parsed.payload.prompt === 'string'
        ? parsed.payload.prompt.trim()
        : '';
      before = await send(
        buildPrompt() + '\n\nATTACHMENT SENT: ' + file.rel + ' (' + file.size + ' bytes).'
        + (extra ? '\nYOUR NOTE WITH THE FILE: ' + extra : '')
        + '\nThe file is already uploaded. Continue the goal.'
      );
      continue;
    }

    if (parsed.kind === 'blocked') {
      state.blocked = true;
      state.blockedAt = Date.now();
      state.blockReason = parsed.summary;
      saveState();
      log('');
      log('=== GOAL BLOCKED ===');
      log(parsed.summary);
      return finishGoal({
        status: 'blocked',
        summary: parsed.summary,
        turns: state.turn,
        reason: parsed.summary,
        canResume: true,
      });
    }

    if (parsed.kind === 'done') {
      const planNow = parsePlan(readMemoryFile('PLAN.md'));
      const reviewNow = state.mode === 'review' ? reviewGate() : null;
      const issues = [];
      const planBlocked = planNow.remaining > 0;
      const reviewBlocked = !!(reviewNow && !reviewNow.ok);

      if (planBlocked && !state.doneNudged) {
        state.doneNudged = true;
        issues.push('PLAN.md still has ' + planNow.remaining + ' unchecked item(s):\n'
          + planNow.open.map((x) => '- ' + x).join('\n'));
      }

      if (reviewBlocked && (state.reviewNudges || 0) < 2) {
        state.reviewNudges = (state.reviewNudges || 0) + 1;
        issues.push('REVIEW GATE: ' + reviewNow.reason);
      }

      if (issues.length) {
        saveState();
        if (finalTurn) {
          return finishGoal({
            status: 'partial',
            reason: 'completion_gate_failed',
            summary: 'Chưa hoàn tất: ' + issues.join(' '),
            turns: state.turn,
            canResume: true,
            verification: currentVerification(),
          });
        }
        log('WARN: DONE blocked by ' + issues.length + ' gate(s); asking for evidence');
        before = await send(
          'DONE BLOCKED. Fix these first:\n\n' + issues.join('\n\n')
          + '\n\nThen reply with exactly ONE fenced block: the fix script, or DONE again.'
        );
        continue;
      }

      if (reviewNow && reviewNow.ok) {
        log('review gate: ' + reviewNow.citations + ' citations across ' + reviewNow.files.length + ' files');
      }

      // Existing PLAN/review gates are part of the completion contract. A
      // nudged gate that is still open cannot be accepted as done.
      if (planBlocked || reviewBlocked) {
        const reason = planBlocked && reviewBlocked
          ? 'plan_and_review_incomplete'
          : planBlocked ? 'plan_incomplete' : 'review_incomplete';
        log('WARN: DONE rejected: ' + reason);
        return finishGoal({
          status: 'partial',
          reason,
          summary: 'Chưa hoàn tất: còn gate chưa đạt. /continue để tiếp tục.',
          turns: state.turn,
          canResume: true,
          verification: currentVerification(),
        });
      }

      // Verifier runs only after the existing gates pass. Its subprocesses
      // never inherit model-proposed commands; only the manifest is used.
      let ver;
      try {
        ver = await runVerification(verificationSpec);
      } catch (e) {
        ver = { status: 'unavailable', checks: [], reason: e.message };
      }
      const recorded = recordVerification(ver);
      saveState();

      if (Date.now() - started > CFG.maxTotalMs) {
        return finishGoal({
          status: 'timed_out',
          reason: 'total time budget reached during verification',
          turns: state.turn,
          canResume: true,
          verification: recorded,
        });
      }

      if (recorded.status === 'passed' || recorded.status === 'unconfigured') {
        let review = await runIndependentReview(page, recorded);
        state.review = { ...(state.review || {}), ...review };
        review = { ...review, attempts: state.review.attempts || 0 };
        saveState();

        if (review.status === 'reviewed' && review.verdict === 'findings') {
          const nextFixRound = (state.review.fixRounds || 0) + 1;
          const canFix = !finalTurn
            && (state.turn - startTurn < CFG.maxTurns)
            && nextFixRound <= 2;
          if (canFix) {
            state.review.fixRounds = nextFixRound;
            saveState();
            log('REVIEW: findings; sending them to the main agent (round ' + nextFixRound + '/2)');
            log('INDEPENDENT REVIEW FINDINGS\n' + formatReviewFindings(review));
            if (!CFG.mock) await resetChat(page);
            before = await send(
              buildPrompt()
              + '\n\nINDEPENDENT REVIEW FINDINGS (read-only reviewer)\n'
              + formatReviewFindings(review)
              + (review.artifactRef || review.evidenceRef
                ? '\nEvidence: ' + (review.artifactRef || review.evidenceRef) : '')
              + '\n\nAddress these findings, then continue the goal. '
              + 'Reply with exactly ONE bash block or DONE after the fix.'
            );
            continue;
          }
          if (CFG.reviewMode === 'required') {
            return finishGoal({
              status: 'partial',
              reason: 'review_findings',
              summary: 'Chưa hoàn tất: reviewer còn findings chưa xử lý. /continue để tiếp tục.',
              turns: state.turn,
              canResume: true,
              verification: recorded,
              review,
            });
          }
        }

        if (['invalid', 'timed_out', 'unavailable'].includes(review.status)
          && CFG.reviewMode === 'required') {
          return finishGoal({
            status: 'partial',
            reason: 'review_' + review.status,
            summary: 'Chưa hoàn tất: review bắt buộc không có kết quả hợp lệ ('
              + review.status + '). ' + (review.reason || ''),
            turns: state.turn,
            canResume: true,
            verification: recorded,
            review,
          });
        }

        log('');
        log('=== GOAL COMPLETE ===');
        log(parsed.summary);
        state.summary = parsed.summary;
        return finishGoal({
          status: 'done',
          summary: parsed.summary,
          turns: state.turn,
          reason: '',
          canResume: false,
          verification: recorded,
          review,
        });
      }

      if (recorded.status === 'unavailable') {
        log('WARN: verification unavailable: ' + (recorded.reason || 'no reason'));
        return finishGoal({
          status: 'partial',
          reason: 'verification_unavailable',
          summary: 'Chưa hoàn tất: không chạy được verifier. '
            + (recorded.reason || 'Cấp lại --verify để tiếp tục.'),
          turns: state.turn,
          canResume: true,
          verification: recorded,
        });
      }

      // failed or stale: ask for one short fix, at most twice per invocation.
      if (!finalTurn && (state.verifyNudges || 0) < 2) {
        state.verifyNudges = (state.verifyNudges || 0) + 1;
        saveState();
        log('WARN: DONE blocked by verification (' + recorded.status + '); asking for a fix ('
          + state.verifyNudges + '/2)');
        before = await send(
          'DONE BLOCKED: verification did not pass.\n\n'
          + verificationIssues(recorded)
          + '\n\nFix the cause, then reply with exactly ONE bash block. '
          + 'Do not reply DONE until the checks pass.'
        );
        continue;
      }

      return finishGoal({
        status: 'partial',
        reason: recorded.status === 'stale' ? 'verification_stale' : 'verification_failed',
        summary: 'Chưa hoàn tất: verification ' + recorded.status + '. /continue để sửa phần còn thiếu.',
        turns: state.turn,
        canResume: true,
        verification: recorded,
      });
    }

    const canon = canonicalScript(parsed.script);
    const requested = requestedSkill(parsed.script);

    if (requested) {
      const skill = findSkill(requested);
      if (!skill) {
        state.nudges++;
        saveState();
        if (state.nudges > 2) throw new HarnessError('skill_unknown', 'Unknown skill requested three times: ' + requested);
        log('WARN: unknown skill: ' + requested);
        before = await send(
          'UNKNOWN SKILL: ' + requested + '\n\n' + skillsPromptBlock()
          + '\n\nUse an exact available name, run a normal bash script, or reply DONE.'
        );
        continue;
      }
      if (!state.selectedSkills.includes(skill.name)) state.selectedSkills.push(skill.name);
      state.nudges = 0;
      saveState();
      log('SKILL: loaded ' + skill.label);
      if (!canon) {
        before = await send(
          buildPrompt() + '\n\nSKILL LOADED: ' + skill.label
          + '. Use its instructions and continue the goal. Reply with exactly ONE fenced block.'
        );
        continue;
      }
    }

    if (!canon) {
      state.nudges++;
      saveState();
      if (state.nudges > 2) {
        throw new HarnessError('empty_script', 'Comment-only scripts three times.');
      }
      log('WARN: script has no commands; asking again');
      before = await send('Your script contained only comments or blank lines. Reply with a real bash script, or DONE.');
      continue;
    }

    if (state.lastScriptCanon === canon) {
      state.scriptRepeat = (state.scriptRepeat || 0) + 1;
      if (state.scriptRepeat >= 3) {
        saveState();
        throw new HarnessError('stuck_script', 'The same script was proposed 3 times without progress.');
      }
      log('WARN: identical script (' + state.scriptRepeat + '/3); not executing it again');
      saveState();
      await dumpPage(page, 'turn-' + (state.turn + 1) + '-repeat');
      before = await send(
        'WARNING: your script is IDENTICAL (ignoring comments) to the previous turn, so the harness did NOT run it again.\n' +
        'Take a different step, or reply DONE if the goal is complete.\n' +
        'Reply with exactly ONE fenced block.\n\n' +
        'LAST RESULT\n' + formatObservation(state.last)
      );
      continue;
    }
    state.scriptRepeat = 0;
    state.lastScriptCanon = canon;

    // Last line of defense: never start a side effect after the action budget
    // is gone, even if a previous branch forgot to stop.
    if (state.turn - startTurn >= CFG.maxTurns) {
      return finishGoal({
        status: 'partial',
        reason: 'turn budget reached (' + CFG.maxTurns + ') before executing action',
        turns: state.turn,
        canResume: true,
        summary: 'Chưa hoàn tất: hết ngân sách action. /continue để tiếp tục.',
        verification: currentVerification(),
      });
    }

    log('');
    log('--- turn ' + (state.turn + 1) + ' ---');
    emitIntent(scriptNote(parsed.script), scriptProgressMeta(parsed.script), state.turn + 1);
    log('script: ' + parsed.script.split('\n').length + ' lines');
    if (CFG.traceScripts) {
      log('__HARNESS_SCRIPT__' + JSON.stringify({ turn: state.turn + 1, script: parsed.script }));
    }

    const res = await executeScript(parsed.script, state.turn + 1);
    const obs = makeObservation(res);
    trackReads(parsed.script, obs);

    state.turn++;
    state.last = obs;
    state.history.push({
      turn: state.turn,
      script: parsed.script.slice(0, 800),
      exit: obs.exit,
      head: obs.body.slice(0, 400),
    });
    if (state.history.length > 50) state.history.shift();

    log('exit=' + obs.exit + ' in ' + obs.durationMs + 'ms (' + obs.lines + ' lines)');
    log('timing: send ' + (sendMs / 1000).toFixed(1)
      + 's | copilot ' + (waitMs / 1000).toFixed(1)
      + 's | exec ' + (obs.durationMs / 1000).toFixed(1)
      + 's | prompt ' + (promptChars / 1000).toFixed(1)
      + 'k chars (~' + (promptChars / 4000).toFixed(1) + 'k tok)');

    syncMemory();

    const sig = signature(obs);
    state.recent.push(sig);
    if (state.recent.length > 6) state.recent.shift();
    const repeats = state.recent.filter((s) => s === sig).length;
    // Must be re-assigned every turn, otherwise one stuck turn poisons every
    // later prompt even after the model recovers.
    state.forceChange = repeats >= 3;
    if (state.forceChange) {
      log('WARN: identical result ' + repeats + 'x; forcing a change of approach');
      emitIntent('Change approach after a repeated result', {
        milestone: 'Change approach',
        changeReason: 'same result repeated ' + repeats + ' times',
      }, state.turn);
    }
    if (repeats >= 5) {
      saveState();
      throw new HarnessError('stuck', 'Same result 5 times. Aborting to avoid burning turns.');
    }

    saveState();

    if (state.turn - startTurn >= CFG.maxTurns) {
      finalTurn = true;
      log('TURN BUDGET: action budget used; allowing one final DONE/BLOCKED turn');
      before = await send(buildFinalPrompt());
      continue;
    }

    if (!CFG.mock && !CFG.perRun && state.turn > 0 && state.turn % CFG.resetAfterTurns === 0) {
      emitPhase('compacting', { turn: state.turn, reason: 'auto-compact threshold' });
      log('__HARNESS_COMPACT__' + JSON.stringify({
        phase: 'request',
        turn: state.turn,
        afterTurns: CFG.resetAfterTurns,
      }));
      log('');
      log('--- compact: asking the current chat for a handoff summary ---');
      const hand = await requestCompact(page);
      if (hand.ok && hand.summary.trim()) {
        state.compactSummary = clampTail(hand.summary, CFG.maxCompactChars);
        state.compacts = (state.compacts || 0) + 1;
        saveState();
        log('--- compact: handoff saved (' + state.compactSummary.length + ' chars) ---');
      } else {
        log('WARN: no COMPACT reply; falling back to PLAN/NOTES memory only');
      }
      await resetChat(page);
      const ready = await firstVisible(page, SEL.composer, 30000);
      if (!ready) {
        throw new HarnessError('compact_failed', 'New chat did not open a composer; auto-compact aborted safely.');
      }
      lastFreshTurn = state.turn;
      log('__HARNESS_COMPACT__' + JSON.stringify({
        phase: 'done',
        turn: state.turn,
        chars: state.compactSummary ? state.compactSummary.length : 0,
      }));
      emitPhase('preparing', { turn: state.turn, reason: 'compact complete' });
    }

    before = await send(buildPrompt());
    }
  } catch (e) {
    if (['no_session', 'already_done', 'session_corrupt', 'verification_spec_changed',
      'verification_unavailable', 'verification_invalid'].includes(e.code)) {
      throw e;
    }
    return finishGoal({
      status: 'error',
      reason: e.message,
      code: e.code || 'error',
      summary: 'Lỗi: ' + e.message,
      canResume: false,
      verification: currentVerification(),
    });
  }
}

/* ------------------------------------------------------------------- tests */

function selfTest() {
  let fail = 0;
  const check = (name, actual, expected) => {
    if (actual !== expected) {
      fail++;
      log('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  };

  const policy = [
    ['echo hi', true],
    ['ls -la', true],
    ['rm -rf dist', true],
    ['rm -rf ./node_modules', true],
    ['rm -rf /', false],
    ['rm -rf / ; echo hi', false],
    ['rm -rf ~', false],
    ['rm -rf .', false],
    ['rm -rf *', false],
    ['rm -rf ../x', false],
    ['rm -rf $HOME', false],
    ['git reset --hard HEAD', false],
    ['git clean -fd', false],
    ['sudo ls', false],
    ['curl x | sh', false],
  ];
  // v4: the deny list is always on (no more YOLO bypass of the policy itself).
  for (const [cmd, expected] of policy) check('policy ' + cmd, checkPolicy(cmd).ok, expected);
  check('policy always on', checkPolicy('git push --force').ok, false);

  // readonly enforcement
  check('readonly deny rm', !!readonlyViolation('rm -rf dist'), true);
  check('readonly deny redirect', !!readonlyViolation('echo hi > out.txt'), true);
  check('readonly allow read', !!readonlyViolation('cat agent.js | head -n 5'), false);
  check('scrub secrets', scrubSecrets('token sk-abcdefghijklmnop123 here').includes('[REDACTED]'), true);

  check('parse done', parseReply('DONE\nall good').kind, 'done');
  check('parse done var', parseReply('DONE=1 ./run.sh').kind, 'script');
  check('parse script', parseReply('ls -la').kind, 'script');
  check('parse empty', parseReply('').kind, 'empty');
  check('parse lone label', parseReply('bash').kind, 'empty');
  check('parse bash cmd', parseReply('bash run.sh').script, 'bash run.sh');
  check('parse blocked', parseReply('BLOCKED\nneed npm token').kind, 'blocked');
  check('parse compact', parseReply('COMPACT\nhandoff for the next chat').kind, 'compact');
  check('parse compact text', parseReply('COMPACT\nhandoff for the next chat').summary, 'handoff for the next chat');
  check('script note', scriptNote('# note: inspect auth\nls'), 'inspect auth');
  const pm = scriptProgressMeta('# note: x\n# progress: {"milestone":"Reproduce","changeReason":"checkpoint rejected"}');
  check('progress meta milestone', pm.milestone, 'Reproduce');
  check('progress meta reason', pm.changeReason, 'checkpoint rejected');
  const badPm = scriptProgressMeta('# progress: {broken json}\nls');
  check('progress meta malformed', badPm.milestone, '');
  check('progress text control chars', progressText('a\u0000b\tc', 20), 'a b c');
  check('clean label', cleanBlock('bash\ncopy\nls -la'), 'ls -la');
  check('clean console label', cleanBlock('console\nnpm test'), 'npm test');
  check('parse lone console label', parseReply('console').kind, 'empty');
  check('clean nbsp', cleanBlock('echo a\n\u00a0\necho b'), 'echo a\n \necho b');
  check('clean zero width', cleanBlock('e\u200bcho hi'), 'echo hi');

  const at = parseReply('ATTACH\n{"file":"notes.txt"}');
  check('parse attach', at.kind, 'attach');
  check('parse attach file', at.payload && at.payload.file, 'notes.txt');
  check('parse attach bad json', parseReply('ATTACH\nnot json').payload, null);

  const av = parseArgv(['--safe', '--max-turns', '7', '--continue', 'sess.json', 'fix tests']);
  check('argv max', av.values['--max-turns'], '7');
  check('argv continue', av.values['--continue'], 'sess.json');
  check('argv goal', av.goal, 'fix tests');
  check('argv flag', av.flags.has('--safe'), true);
  check('argv readonly', parseArgv(['--readonly', 'review this']).flags.has('--readonly'), true);

  const savedAttachWork = CFG.workdir;
  const savedAttachSession = CFG.sessionFile;
  const tmpAttach = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attach-'));
  try {
    CFG.workdir = tmpAttach;
    CFG.sessionFile = null;
    fs.writeFileSync(path.join(tmpAttach, 'ok.txt'), 'hello');
    fs.writeFileSync(path.join(tmpAttach, '.env'), 'SECRET=1');
    check('attach resolve rel', resolveAttachment('ok.txt').rel, 'ok.txt');
    const attachCode = (rel) => {
      try { resolveAttachment(rel); return ''; } catch (e) { return e.code; }
    };
    check('attach secret', attachCode('.env'), 'attach_secret');
    check('attach outside', attachCode('/etc/hosts'), 'attach_outside');
    check('attach missing', attachCode('nope.txt'), 'attach_missing');
  } finally {
    CFG.workdir = savedAttachWork;
    CFG.sessionFile = savedAttachSession;
    try { fs.rmSync(tmpAttach, { recursive: true, force: true }); } catch {}
  }

  const plan = parsePlan('- [x] done\n- [ ] todo one\n* [X] done two\n- [ ] todo two');
  check('plan total', plan.total, 4);
  check('plan done', plan.done, 2);
  check('plan remaining', plan.remaining, 2);
  check('plan open', plan.open.length, 2);

  check('canon script', canonicalScript('# retry\nls -la   \n\n'), 'ls -la');

  check('mode review', detectMode('review services/pay and evaluate the design'), 'review');
  check('mode build', detectMode('upgrade plugin foo and run tests'), 'build');
  check('mode fix', detectMode('review and fix the service'), 'build');
  check('mode build summary', detectMode('run pwd and echo ok, then a short summary'), 'build');
  check('mode review summary', detectMode('review the parser and summarize'), 'review');

  check('copilot url consumer', isCopilotUrl('https://copilot.com/chats/1'), true);
  check('copilot url m365', isCopilotUrl('https://copilot.cloud.microsoft/chat'), true);
  check('copilot url legacy', isCopilotUrl('https://copilot.microsoft.com/'), true);
  check('copilot url evil', isCopilotUrl('https://evilcopilot.com/'), false);
  check('copilot url login', isCopilotUrl('https://login.microsoftonline.com/common/oauth2/authorize'), false);

  const merged = mergeRanges([[1, 3], [2, 5], [10, 12]]);
  check('merge count', merged.length, 2);
  check('merge first', merged[0][0] + '-' + merged[0][1], '1-5');

  check('read heavy sed', isReadHeavy('sed -n "1,200p" src/a.ts'), true);
  check('read heavy write', isReadHeavy('sed -i s/a/b/ src/a.ts'), false);
  check('read heavy npm', isReadHeavy('npm test'), false);
  check('read heavy cat', isReadHeavy('cat src/a.ts | head -n 20'), true);

  const reviewText = '## Files read\n- src/a.ts:1-120\n\n## Findings\n'
    + '- issue - src/a.ts:12\n- issue - src/b.ts:30\n';
  const rg = reviewGateText(reviewText);
  check('review gate ok', rg.ok, true);
  check('review gate cites', rg.citations, 2);
  check('review gate missing', reviewGateText('## Files read\nsrc/a.ts\n## Findings\nnone').ok, false);

  const raw = '\u001b[31merror\u001b[0m: boom\rprogress 10%\rprogress 100%\nok';
  const obs = makeObservation({ output: raw, exit: 1, durationMs: 5, bytes: raw.length, runDir: '/tmp/x' });
  check('ansi stripped', obs.body.includes('\u001b'), false);
  check('cr collapsed', obs.body.includes('progress 100%'), true);
  check('highlight', obs.body.includes('error: boom'), true);

  const longRaw = Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n') + '\nERROR: final failure';
  const obs2 = makeObservation({ output: longRaw, exit: 1, durationMs: 1, bytes: longRaw.length, runDir: '/tmp/x' });
  check('tail kept', obs2.body.includes('ERROR: final failure'), true);

  const midRaw = Array.from({ length: 60 }, (_, i) => 'line ' + i).join('\n');
  const obsMid = makeObservation({ output: midRaw, exit: 0, durationMs: 1, bytes: midRaw.length, runDir: '/tmp/x' });
  check('short output keeps all lines', obsMid.body.includes('line 59'), true);

  const readRaw = Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n');
  const obsRead = makeObservation({
    output: readRaw,
    exit: 0,
    durationMs: 1,
    bytes: readRaw.length,
    runDir: '/tmp/x',
    readHeavy: true,
    readHint: "sed -n '141,280p' 'x.ts'",
  });
  check('read head 140', obsRead.headShown, 140);
  check('read hint', obsRead.body.includes("sed -n '141,280p'"), true);

  const savedState = state;
  state = newState('review a file');
  trackReads("sed -n '1,20p' agent.js", { headShown: 140, truncated: false });
  check('track read range', JSON.stringify(state.reads['agent.js'] || []), '[[1,20]]');
  state.reads = {};
  state.readOrder = [];
  trackReads('cat agent.js', { headShown: 140, truncated: true });
  const tracked = state.reads['agent.js'] || [];
  check('track truncated cat', tracked[0] && tracked[0][1], 140);
  state = savedState;

  const savedWorkdir = CFG.workdir;
  const savedState2 = state;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-selftest-'));
  try {
    CFG.workdir = tmp;
    fs.mkdirSync(path.join(tmp, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a.ts'), Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n'));
    fs.writeFileSync(path.join(tmp, 'b.ts'), Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n'));
    fs.writeFileSync(path.join(tmp, '.harness', 'REVIEW.md'),
      '## Files read\n- a.ts:1-20\n\n## Findings\n- x - a.ts:10\n- y - a.ts:15\n\n## Unverified\n(none)\n');

    state = newState('review a.ts');
    state.scope = ['a.ts'];
    state.reads = { 'a.ts': [[1, 20]] };
    state.readOrder = ['a.ts'];
    check('review gate coverage ok', reviewGate().ok, true);

    state.reads = { 'a.ts': [[1, 5]] };
    check('review gate line fail', reviewGate().ok, false);

    state.reads = { 'a.ts': [[1, 20]] };
    state.scope = ['a.ts', 'b.ts'];
    check('review gate unread scope fail', reviewGate().ok, false);

    fs.writeFileSync(path.join(tmp, '.harness', 'REVIEW.md'),
      '## Files read\n- a.ts:1-20\n\n## Findings\n- x - a.ts:10\n- y - a.ts:15\n\n## Unverified\n- b.ts: not read\n');
    check('review gate unread scope listed', reviewGate().ok, true);
  } finally {
    CFG.workdir = savedWorkdir;
    state = savedState2;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // v4 checkpoint migration: partial wins over done, unknown fields survive.
  const legacy = migrateSession({
    schemaVersion: 4,
    goal: 'legacy',
    done: true,
    doneAt: 123,
    partial: true,
    turn: 7,
    history: [{ turn: 7 }],
    customField: { keep: true },
  });
  check('migrate done+partial status', legacy.status, 'partial');
  check('migrate done+partial done', legacy.done, false);
  check('migrate done+partial no doneAt', legacy.doneAt, undefined);
  check('migrate keeps turn', legacy.turn, 7);
  check('migrate keeps history', legacy.history.length, 1);
  check('migrate keeps unknown', legacy.customField.keep, true);

  const validDone = migrateSession({ schemaVersion: 4, goal: 'x', done: true, doneAt: 9 });
  check('migrate valid done', validDone.status, 'done');
  check('migrate valid doneAt', validDone.doneAt, 9);

  const blockedLegacy = migrateSession({ schemaVersion: 3, goal: 'x', blocked: true });
  check('migrate blocked resumable', blockedLegacy.status, 'blocked');
  check('migrate started actions', startedActions({
    actions: { 1: { status: 'started' }, 2: { status: 'finished' } },
  }).length, 1);

  const savedState3 = state;
  state = null;
  const partialResult = terminalResult('partial', { turns: 4 });
  check('terminal partial exit', partialResult.exitCode, 3);
  check('terminal partial canResume', partialResult.canResume, true);
  const doneResult = terminalResult('done', { turns: 4 });
  check('terminal done exit', doneResult.exitCode, 0);
  check('terminal done canResume', doneResult.canResume, false);
  const blockedResult = terminalResult('blocked', {});
  check('terminal blocked exit', blockedResult.exitCode, 2);
  state = savedState3;

  // Corrupt session is distinct from a missing one.
  const savedSessionFile = CFG.sessionFile;
  const badSession = path.join(os.tmpdir(), 'agent-selftest-session-' + process.pid + '.json');
  try {
    fs.writeFileSync(badSession, '{not json');
    CFG.sessionFile = badSession;
    check('loadState missing-like corrupt', loadState(), null);
    let corruptCode = '';
    try { loadState(true); } catch (e) { corruptCode = e.code; }
    check('loadState strict corrupt', corruptCode, 'session_corrupt');
  } finally {
    CFG.sessionFile = savedSessionFile;
    try { fs.rmSync(badSession, { force: true }); } catch {}
  }

  // Checkpoint write failure is an explicit error, not a silent log line.
  const savedSessionFile2 = CFG.sessionFile;
  const savedTestFail = process.env.HARNESS_TEST_FAIL_SAVE;
  const savedState4 = state;
  try {
    CFG.sessionFile = path.join(os.tmpdir(), 'agent-selftest-save-' + process.pid + '.json');
    state = newState('checkpoint write test');
    process.env.HARNESS_TEST_FAIL_SAVE = 'selftest';
    let writeCode = '';
    try { saveState('selftest'); } catch (e) { writeCode = e.code; }
    check('checkpoint write failure code', writeCode, 'checkpoint_write_failed');
  } finally {
    process.env.HARNESS_TEST_FAIL_SAVE = savedTestFail;
    CFG.sessionFile = savedSessionFile2;
    state = savedState4;
  }

  // Verification manifest validation and content fingerprints.
  const vtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-verify-'));
  const voutside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-verify-out-'));
  const savedVerifyWorkdir = CFG.workdir;
  try {
    CFG.workdir = vtmp;
    fs.mkdirSync(path.join(vtmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(vtmp, 'src', 'filter.js'), '// GOOD\n');
    const checker = path.join(voutside, 'check.js');
    fs.writeFileSync(checker, 'process.exit(0);\n');
    const manifestFile = path.join(voutside, 'manifest.json');
    const writeManifest = (data) => fs.writeFileSync(manifestFile, JSON.stringify(data));
    writeManifest({
      version: 1,
      inputPaths: ['src/filter.js'],
      checks: [{ id: 'filter-empty', command: process.execPath, args: [checker], timeoutMs: 5000 }],
    });
    const spec = loadVerificationSpec(manifestFile);
    check('verify spec inputs', spec.inputPaths[0], 'src/filter.js');
    check('verify spec checks', spec.checks.length, 1);
    check('verify spec tool files', spec.toolFiles.length >= 2, true);
    const fp1 = fingerprintVerification(spec);
    fs.writeFileSync(path.join(vtmp, 'src', 'filter.js'), '// GOOD changed\n');
    const fp2 = fingerprintVerification(spec);
    check('verify fingerprint changes', fp1 !== fp2, true);

    writeManifest({
      version: 1,
      inputPaths: ['../escape.js'],
      checks: [{ id: 'x', command: process.execPath, args: [], timeoutMs: 5000 }],
    });
    let escapeCode = '';
    try { loadVerificationSpec(manifestFile); } catch (e) { escapeCode = e.code; }
    check('verify escape rejected', escapeCode, 'verification_invalid');

    writeManifest({ version: 1, inputPaths: ['src/filter.js'], checks: [{ id: 'x', command: 'node', args: [] }] });
    let relativeCode = '';
    try { loadVerificationSpec(manifestFile); } catch (e) { relativeCode = e.code; }
    check('verify relative command rejected', relativeCode, 'verification_invalid');

    writeManifest({
      version: 1,
      inputPaths: ['src/filter.js'],
      checks: [{ id: 'x', command: process.execPath, args: [checker], timeoutMs: 5 }],
    });
    let timeoutCode = '';
    try { loadVerificationSpec(manifestFile); } catch (e) { timeoutCode = e.code; }
    check('verify timeout bounds', timeoutCode, 'verification_invalid');
  } finally {
    CFG.workdir = savedVerifyWorkdir;
    try { fs.rmSync(vtmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(voutside, { recursive: true, force: true }); } catch {}
  }

  // Skills: frontmatter names, duplicate disambiguation, symlink escape.
  const stmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
  const sout = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-out-'));
  const savedSkillWorkdir = CFG.workdir;
  const savedSkillState = state;
  try {
    CFG.workdir = stmp;
    const skillRoot = path.join(stmp, '.cursor', 'skills');
    const writeSkill = (rel, text) => {
      const dir = path.join(skillRoot, rel);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
    };
    writeSkill('alpha', '---\nname: alpha\n---\nALPHA BODY\n');
    writeSkill('beta', '---\nname: beta\n---\nBETA BODY\n');
    writeSkill('dup-one', '---\nname: same\n---\nSAME ONE\n');
    writeSkill('dup-two', '---\nname: same\n---\nSAME TWO\n');
    fs.mkdirSync(path.join(skillRoot, 'escape'), { recursive: true });
    const outsideSkill = path.join(sout, 'SKILL.md');
    fs.writeFileSync(outsideSkill, '---\nname: escaped\n---\nESCAPED BODY\n');
    fs.symlinkSync(outsideSkill, path.join(skillRoot, 'escape', 'SKILL.md'));

    refreshSkills();
    const list = loadAvailableSkills();
    check('skills found', list.length, 4);
    check('skills no symlink escape', list.some((s) => s.name === 'escaped'), false);
    const dupLabels = list.filter((s) => s.name === 'same').map((s) => s.label);
    check('skills duplicate labels', dupLabels.length, 2);
    check('skills duplicate rel', dupLabels.every((l) => l.includes('.cursor/skills/')), true);

    state = newState('please use alpha for this task');
    state.selectedSkills = skillsForGoal(state.goal);
    const prompt = buildPrompt();
    check('skills listed once', prompt.split('AVAILABLE SKILLS').length - 1, 1);
    check('skills alpha content', prompt.includes('ALPHA BODY'), true);
    check('skills beta not loaded', prompt.includes('BETA BODY'), false);
    check('skills goal match', state.selectedSkills.includes('alpha'), true);
  } finally {
    CFG.workdir = savedSkillWorkdir;
    state = savedSkillState;
    refreshSkills();
    try { fs.rmSync(stmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(sout, { recursive: true, force: true }); } catch {}
  }

  log(fail ? 'SELFTEST FAILED (' + fail + ')' : 'SELFTEST OK');
  if (fail) process.exitCode = 1;
}

/* ------------------------------------------------------------------ probe */

async function probe(page) {
  await page.bringToFront();
  log('URL: ' + page.url());

  // SEL also contains a plain string (fileInput); only arrays are selector groups.
  const groups = {};
  for (const [key, value] of Object.entries(SEL)) {
    if (Array.isArray(value)) groups[key] = value;
  }

  const report = await page.evaluate((sels) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const out = {};
    for (const [group, list] of Object.entries(sels)) {
      out[group] = list.map((sel) => {
        let total = 0;
        let shown = 0;
        try {
          const nodes = document.querySelectorAll(sel);
          total = nodes.length;
          for (const n of nodes) if (visible(n)) shown++;
        } catch {}
        return { sel, total, visible: shown };
      });
    }
    out.bodyTextLength = document.body.innerText.length;
    return out;
  }, groups).catch(() => ({ error: 'page navigated during probe' }));

  for (const [group, rows] of Object.entries(report)) {
    if (!Array.isArray(rows)) { log(group + ': ' + rows); continue; }
    log('');
    log('[' + group + ']');
    for (const r of rows) log('  ' + r.visible + '/' + r.total + '  ' + r.sel);
  }
}

/* ------------------------------------------------------------------- main */

function usage() {
  return [
    'Edge Copilot terminal harness (v4)',
    '',
    'Usage:',
    '  node agent.js "goal"                 run a goal (default: yolo)',
    '  node agent.js --ask "goal"           approve each action',
    '  node agent.js --yolo "goal"          host unrestricted, no approvals',
    '  node agent.js --preview "goal"       propose only, never execute',
    '  node agent.js --readonly "goal"      engine-enforced read-only',
    '  node agent.js --isolated "goal"      requires HARNESS_ISOLATED_BACKEND',
    '  node agent.js --continue [file]      resume a saved session',
    '  node agent.js --verify <file.json>   run manifest checks before accepting DONE',
    '  node agent.js --review "goal"        opt-in independent reviewer after verify',
    '  node agent.js --review-required "goal" reviewer result is required for done',
    '  node agent.js --no-review "goal"    disable a reviewer saved in the session',
    '  node agent.js --per-run "goal"       fresh chat before every turn',
    '  node agent.js --auto-compact 10 "goal"  COMPACT handoff -> new chat',
    '  node agent.js --new-chat            compact handoff + new chat, then exit',
    '  node agent.js --no-attach "goal"     disable the ATTACH protocol',
    '  node agent.js --launch "goal"        launch Edge (debug profile) if needed',
    '  node agent.js --login                launch Edge and wait for Copilot sign-in',
    '  node agent.js --probe                inspect selectors on the live page',
    '  node agent.js --prompt "goal"        print the first prompt, no browser',
    '  node agent.js --context              show repo instructions + memory + git',
    '  node agent.js --selftest             run unit tests (no browser)',
    '  node agent.js --mock                 local end-to-end test (headless Edge)',
    '  node agent.js --json "goal"          machine-readable result (used by MCP)',
    '  node agent.js --events               NDJSON control events (used by TUI)',
    '  node agent.js [opts] -- <goal>       everything after -- is the literal goal',
    '',
    'Options:',
    '  --cdp <url>          CDP endpoint (default http://127.0.0.1:9222)',
    '  --chat-url <url>     Copilot URL (default https://copilot.cloud.microsoft/chat)',
    '  --max-turns <n>      turn budget (default 60)',
    '  --auto-compact <n>   new chat every N turns (default 10)',
    '  --workdir <dir>      project directory (default: current directory)',
    '  --session <file>     session JSON path',
    '  --verify <file>      verification manifest (absolute command + args)',
    '  --lang <code>        answer language: vi (default) or en',
    '  --profile <dir>      Edge profile used by --launch/--login',
    '',
    'Env: CDP_URL, CHAT_URL, EDGE_BIN, EDGE_PROFILE, HARNESS_HOME, HARNESS_MODE,',
    '     HARNESS_LANG=vi|en, MAX_TURNS, MAX_TURN_MS, MAX_TOTAL_MS, SCRIPT_TIMEOUT_MS,',
    '     AUTO_COMPACT_TURNS, APPROVAL_TIMEOUT_MS, HARNESS_ISOLATED_BACKEND,',
    '     HARNESS_REVIEW=1|required, REVIEW_MAX',
  ].join('\n');
}

const VALUE_FLAGS = new Set([
  '--session', '--cdp', '--chat-url', '--max-turns', '--max-total-ms',
  '--max-turn-ms', '--profile', '--workdir', '--auto-compact', '--verify', '--lang',
]);

function parseArgv(argv) {
  const flags = new Set();
  const values = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Everything after -- is the literal goal, even if it starts with --.
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }

    let key = arg;
    let value = null;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }

    if (key === '--continue') {
      flags.add(key);
      if (value == null && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      }
      if (value) values[key] = value;
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      if (value == null) {
        value = argv[++i];
      }
      if (value == null) {
        throw new HarnessError('bad_flag', key + ' needs a value');
      }
      values[key] = value;
      continue;
    }

    flags.add(key);
  }

  return { flags, values, goal: rest.join(' ').trim() };
}

async function finishRun(browser) {
  // Playwright's connectOverCDP closes only the connection on browser.close(),
  // not the user's Edge process. Always disconnect so the CLI can exit.
  try { await browser.close(); } catch {}
  if (CFG.mock) cleanupMock();
}

async function main() {
  ensureDirs();

  const { flags, values, goal: goalInput } = parseArgv(process.argv.slice(2));
  let goalArg = goalInput;

  if (flags.has('--help')) {
    process.stdout.write(usage() + '\n');
    return;
  }

  // v4 permission modes. Deny list is always on; --safe is now an alias of ask.
  if (flags.has('--yolo')) CFG.mode = 'yolo';
  if (flags.has('--ask') || flags.has('--safe')) CFG.mode = 'ask';
  if (flags.has('--preview')) CFG.mode = 'preview';
  if (flags.has('--readonly') || flags.has('--read-only')) { CFG.mode = 'readonly'; CFG.readonly = true; }
  if (flags.has('--isolated')) CFG.mode = 'isolated';
  if (flags.has('--per-run')) CFG.perRun = true;
  if (flags.has('--no-attach') || flags.has('--no-attachments')) CFG.noAttach = true;
  if (flags.has('--json')) CFG.json = true;
  if (flags.has('--events')) { CFG.events = true; CFG.traceScripts = true; }
  if (flags.has('--mock')) CFG.mock = true;
  if (flags.has('--launch')) CFG.launch = true;
  if (flags.has('--login') || flags.has('--login-only')) CFG.loginOnly = true;
  if (flags.has('--review')) { CFG.reviewMode = 'optional'; CFG.reviewExplicit = true; }
  if (flags.has('--review-required')) { CFG.reviewMode = 'required'; CFG.reviewExplicit = true; }
  if (flags.has('--no-review')) { CFG.reviewMode = 'off'; CFG.reviewExplicit = true; }

  if (values['--cdp']) CFG.cdp = values['--cdp'];
  if (values['--chat-url']) CFG.chatUrl = values['--chat-url'];
  if (values['--profile']) CFG.profileDir = path.resolve(values['--profile']);
  if (values['--session']) CFG.sessionFile = path.resolve(values['--session']);
  if (values['--continue']) CFG.sessionFile = path.resolve(values['--continue']);
  if (values['--verify']) CFG.verifyPath = path.resolve(values['--verify']);
  if (values['--lang']) CFG.lang = String(values['--lang']).toLowerCase();
  if (values['--max-turns']) {
    const n = Number(values['--max-turns']);
    if (!Number.isFinite(n) || n < 1) throw new HarnessError('bad_flag', '--max-turns must be >= 1');
    CFG.maxTurns = Math.floor(n);
  }
  if (values['--auto-compact']) {
    const n = Number(values['--auto-compact']);
    if (!Number.isFinite(n) || n < 2) throw new HarnessError('bad_flag', '--auto-compact must be >= 2');
    CFG.resetAfterTurns = Math.floor(n);
  }
  if (values['--max-total-ms']) {
    const n = Number(values['--max-total-ms']);
    if (!Number.isFinite(n) || n < 1000) throw new HarnessError('bad_flag', '--max-total-ms must be >= 1000');
    CFG.maxTotalMs = Math.floor(n);
  }
  if (values['--max-turn-ms']) {
    const n = Number(values['--max-turn-ms']);
    if (!Number.isFinite(n) || n < 1000) throw new HarnessError('bad_flag', '--max-turn-ms must be >= 1000');
    CFG.maxTurnMs = Math.floor(n);
  }
  if (values['--workdir']) {
    const dir = path.resolve(values['--workdir']);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new HarnessError('bad_workdir', '--workdir is not a directory: ' + dir);
    }
    CFG.workdir = dir;
    process.chdir(dir);
  }

  if (flags.has('--selftest')) {
    selfTest();
    return;
  }

  if (flags.has('--prompt')) {
    state = newState(goalArg || 'PREVIEW GOAL');
    refreshSkills();
    state.selectedSkills = skillsForGoal(state.goal);
    if (state.mode === 'review') state.scope = extractScope(state.goal);
    syncMemory();
    state.gitBranch = gitBranch();
    process.stdout.write(buildPrompt() + '\n');
    return;
  }

  if (flags.has('--context')) {
    ensureGitExclude();
    const instr = loadProjectInstructions();
    const cmds = loadProjectCommands();
    log('WORKDIR: ' + CFG.workdir);
    log('PROJECT INSTRUCTIONS: ' + (instr ? instr.length + ' chars' : 'none'));
    if (instr) log(instr);
    log('PROJECT COMMANDS: ' + (cmds || 'none'));
    const plan = parsePlan(readMemoryFile('PLAN.md'));
    log('PLAN: ' + plan.done + '/' + plan.total + ' done, ' + plan.remaining + ' open');
    for (const item of plan.open) log('  [ ] ' + item);
    const git = gitSummary();
    log('GIT: ' + (git ? '\n' + git : 'clean or not a repo'));
    return;
  }

  const wantsContinue = flags.has('--continue');
  const wantsNewChat = flags.has('--new-chat');
  if (CFG.mock && !goalArg && !CFG.loginOnly && !wantsContinue) {
    goalArg = 'mock smoke test';
  }
  if (wantsContinue) {
    if (goalArg) log('WARN: a goal was supplied with --continue; it is ignored (resume uses the saved goal)');
  } else if (!goalArg && !CFG.loginOnly && !CFG.mock && !flags.has('--probe') && !wantsNewChat) {
    if (!process.stdin.isTTY) {
      process.stdout.write(usage() + '\n');
      throw new HarnessError('no_goal', 'No goal given and stdin is not a TTY.');
    }
  }

  // Resume checks that must happen before touching the provider: corrupt
  // session, an action interrupted mid-flight, or a changed verifier config.
  if (wantsContinue) {
    const saved = loadState(true);
    if (!saved) throw new HarnessError('no_session', 'Nothing to continue: session.json not found.');
    const migrated = migrateSession(saved);
    if (migrated.status === 'done' || (migrated.done === true && migrated.partial !== true)) {
      const err = new HarnessError('already_done',
        'The last goal is already DONE. Start a new goal instead of --continue.');
      err.turns = migrated.turn || 0;
      throw err;
    }
    const interrupted = startedActions(migrated);
    if (interrupted.length) {
      CFG.runId = CFG.runId || newRunId();
      const inspection = interrupted.map((a) => ({
        id: a.id,
        kind: a.kind,
        turn: a.turn,
        startedAt: a.startedAt || null,
        script: a.script ? String(a.script).slice(0, 400) : undefined,
        file: a.file || undefined,
      }));
      const result = terminalResult('blocked', {
        status: 'blocked',
        reason: 'resume_inspection_required',
        summary: 'Checkpoint có action đã bắt đầu nhưng chưa có kết quả. '
          + 'Kiểm tra workspace rồi đánh dấu finished hoặc xoá action khỏi session trước khi /continue.',
        turns: migrated.turn || 0,
        canResume: false,
        inspection: { actions: inspection },
        verification: migrated.verification || { status: 'unconfigured', checks: [] },
      });
      log('BLOCKED: resume_inspection_required');
      for (const a of inspection) log('  action #' + a.id + ' · ' + a.kind + ' · turn ' + a.turn);
      emitResult(result);
      emitEvent('run.finished', {
        status: result.status,
        turns: result.turns,
        reason: result.reason,
        canResume: false,
        exitCode: result.exitCode,
        verification: result.verification,
        artifactPaths: result.artifactPaths,
      });
      process.exitCode = result.exitCode;
      return;
    }
    resolveVerificationForState(migrated);
  } else if (CFG.verifyPath) {
    // Validate the manifest before any provider contact.
    verificationSpec = loadVerificationSpec(CFG.verifyPath);
  }

  if (!chromium) {
    throw new HarnessError('no_playwright',
      'Playwright is not installed. Run: cd ' + __dirname + ' && npm install');
  }

  if (CFG.mock) {
    if (CFG.perRun) {
      CFG.perRun = false;
      log('WARN: --per-run is ignored in --mock (a fresh chat would reset the scripted mock).');
    }
    log('MOCK: starting local end-to-end test');
    await startMock();
  } else {
    if (CFG.launch || CFG.loginOnly) {
      const launched = await launchEdge();
      if (launched) log('LAUNCHED: Edge on ' + CFG.cdp);
    }
    if (!(await cdpVersion(CFG.cdp))) {
      throw new HarnessError('no_cdp',
        'Cannot connect to Edge CDP at ' + CFG.cdp + '.\n'
        + 'Run this once: node agent.js --login\n'
        + 'or start Edge with: --remote-debugging-port=9222 --user-data-dir="' + CFG.profileDir + '"');
    }
  }

  if (CFG.mode === 'isolated' && !process.env.HARNESS_ISOLATED_BACKEND) {
    throw new HarnessError('isolated_unavailable',
      'Isolated mode needs a verified backend. Set HARNESS_ISOLATED_BACKEND=<container|vm|...> with a real runner first.');
  }

  CFG.runId = newRunId();
  const lockPath = acquireWorkspaceLock();
  process.on('exit', () => releaseWorkspaceLock(lockPath));

  log('RUN: ' + CFG.runId + ' · mode=' + CFG.mode
    + (CFG.mode === 'yolo' ? ' (host unrestricted, deny list still on)' : ''));
  emitEvent('run.info', {
    runId: CFG.runId,
    mode: CFG.mode,
    workspace: CFG.workdir,
    provider: CFG.mock ? 'mock' : 'edge-copilot',
  });

  log('POLICY: deny list on · mode ' + CFG.mode);
  log('Connecting to Edge CDP at ' + CFG.cdp);
  patchEdgeCDP();
  const browser = await chromium.connectOverCDP(CFG.cdp);

  let page;
  if (CFG.mock) {
    page = await findMockPage(browser);
  } else {
    page = await findCopilotPage(browser);
    await page.bringToFront();
  }
  log('PAGE: ' + page.url());

  if (flags.has('--probe')) {
    await probe(page);
    await finishRun(browser);
    return;
  }

  if (CFG.loginOnly) {
    const found = await waitForAnyComposer(browser, CFG.loginWaitMs, 'Copilot composer');
    if (!found) {
      throw new HarnessError('login_timeout',
        'Copilot composer did not appear in ' + Math.round(CFG.loginWaitMs / 1000) + 's. '
        + 'Sign in at https://copilot.cloud.microsoft/chat in the Edge window, then run --login again.');
    }
    page = found;
    log('PAGE: ' + page.url());
    log('');
    log('LOGIN OK: Copilot is ready in this Edge profile.');
    log('Next: node agent.js "your goal"');
    await finishRun(browser);
    return;
  }

  if (wantsNewChat) {
    const composer = await firstVisible(page, SEL.composer, 30000);
    if (!composer) {
      throw new HarnessError('no_composer', 'Copilot composer not found; cannot start a new chat. Run --probe.');
    }

    let chars = 0;
    const saved = loadState();
    if (!CFG.mock && saved && !saved.done) {
      log('NEW CHAT: asking the current chat for a handoff summary…');
      log('__HARNESS_COMPACT__' + JSON.stringify({ phase: 'request', turn: saved.turn || 0, manual: true }));
      const hand = await requestCompact(page);
      if (hand.ok && hand.summary.trim()) {
        state = saved;
        state.compactSummary = clampTail(hand.summary, CFG.maxCompactChars);
        state.compacts = (state.compacts || 0) + 1;
        saveState();
        chars = state.compactSummary.length;
        log('--- compact: handoff saved (' + chars + ' chars) ---');
      } else {
        log('WARN: no COMPACT reply; the next run will rely on PLAN/NOTES memory');
      }
    }

    log('NEW CHAT: starting a fresh Copilot conversation');
    await resetChat(page);
    log('__HARNESS_COMPACT__' + JSON.stringify({ phase: 'done', chars, manual: true }));
    log('NEW CHAT OK' + (chars ? ' · handoff saved (' + chars + ' chars)' : ''));
    await finishRun(browser);
    return;
  }

  if (CFG.launch && !CFG.mock) {
    const found = await waitForAnyComposer(browser, Math.min(CFG.loginWaitMs, 180000), 'Copilot composer');
    if (!found) {
      throw new HarnessError('login_timeout',
        'Copilot composer did not appear. Sign in in the Edge window, then re-run --login.');
    }
    page = found;
    log('PAGE: ' + page.url());
  }

  const onSignal = () => {
    if (CFG.cancelled) process.exit(130);
    CFG.cancelled = true;
    if (CFG.terminalEmitted) {
      if (currentChild) killTree(currentChild.pid);
      if (CFG.mock) cleanupMock();
      process.exit(130);
    }
    log('');
    log('SIGINT: saving state and stopping');
    emitPhase('stopping', { reason: 'interrupted by user' });
    if (currentChild) killTree(currentChild.pid);
    if (state) {
      state.status = 'cancelled';
      state.done = false;
      delete state.doneAt;
      state.partial = true;
      state.lastResult = { status: 'cancelled', reason: 'interrupted by user', canResume: true, at: Date.now() };
    }
    let saved = false;
    try { saveState('finalize'); saved = true; } catch (e) {
      log('ERROR: checkpoint write failed at cancel: ' + e.message);
    }
    const cancelResult = terminalResult('cancelled', {
      reason: 'interrupted by user',
      canResume: saved,
      summary: 'Đã hủy. /continue để tiếp tục.',
      verification: currentVerification(),
    });
    emitEvent('run.finished', {
      status: cancelResult.status,
      turns: state ? state.turn : 0,
      reason: cancelResult.reason,
      canResume: cancelResult.canResume,
      exitCode: cancelResult.exitCode,
      verification: cancelResult.verification,
      artifactPaths: cancelResult.artifactPaths,
    });
    emitResult(cancelResult);
    if (CFG.mock) cleanupMock();
    process.exit(4);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (wantsContinue) {
    const result = await runGoal(page, null, { resume: true });
    emitResult(result || { status: 'done' });
    if (result) process.exitCode = result.exitCode == null
      ? exitCodeForStatus(result.status) : result.exitCode;
    await finishRun(browser);
    return;
  }

  if (goalArg) {
    const result = await runGoal(page, goalArg);
    emitResult(result || { status: 'done' });
    if (result) process.exitCode = result.exitCode == null
      ? exitCodeForStatus(result.status) : result.exitCode;
    await finishRun(browser);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  log('');
  log('Interactive session. Type a goal, or /exit.');
  for (;;) {
    const line = (await ask('\nGOAL> ')).trim();
    if (!line) continue;
    if (/^\/(exit|quit)$/i.test(line)) break;
    try {
      await runGoal(page, line);
    } catch (e) {
      log('ERROR [' + (e.code || 'unknown') + ']: ' + e.message);
      saveState();
    }
  }
  rl.close();
  await finishRun(browser);
}

main().catch((e) => {
  log('');
  log('FATAL [' + (e.code || 'unknown') + ']: ' + e.message);
  if (e.detail) log(String(e.detail));
  const status = e.code === 'max_time' ? 'timed_out' : 'error';
  const canResume = e.code === 'max_time' || e.code === 'workspace_busy';
  emitResult({
    status,
    code: e.code || 'unknown',
    message: e.message,
    reason: e.message,
    canResume,
    turns: e.turns == null ? undefined : e.turns,
    verification: currentVerification(),
  });
  emitEvent('run.finished', {
    status,
    reason: e.message,
    canResume,
    exitCode: status === 'timed_out' ? 5 : 1,
    verification: currentVerification(),
    artifactPaths: [runDir()],
  });
  if (state) {
    state.status = status;
    state.done = false;
    delete state.doneAt;
    state.lastResult = {
      status,
      code: e.code || 'unknown',
      reason: e.message,
      canResume,
      at: Date.now(),
    };
    saveState();
  }
  if (CFG.mock) cleanupMock();
  process.exit(status === 'timed_out' ? 5 : 1);
});
