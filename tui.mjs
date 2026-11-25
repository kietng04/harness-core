#!/usr/bin/env node
/**
 * tui.mjs - Codex CLI-style terminal UI for the Edge Copilot harness.
 *
 * Frontend only. Every goal runs through agent.js, which drives Edge Copilot
 * over CDP and executes the commands it proposes. There is no Codex model here.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoSearch = require('./repo-search.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = process.env.HARNESS_AGENT_BIN
  ? path.resolve(process.env.HARNESS_AGENT_BIN)
  : path.join(HERE, 'agent.js');
const CDP = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/+$/, '');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const MAX_BLOCKS = 600;
const MAX_OUTPUT_LINES = 240;

const PHASE_LABEL = {
  preparing: 'Đang chuẩn bị',
  waiting: 'Đang chờ Copilot',
  approval: 'Chờ duyệt',
  running: 'Đang chạy',
  verifying: 'Đang xác minh',
  compacting: 'Đang chuyển chat',
  reviewing: 'Đang review độc lập',
  stopping: 'Đang dừng',
};

const SLASH = [
  ['/safe', 'approve each action (ask mode)'],
  ['/yolo', 'default: run without per-action approval'],
  ['/readonly', 'toggle review mode (no project edits)'],
  ['/mock', 'toggle local mock Copilot (no login)'],
  ['/max', 'set the turn budget'],
  ['/auto-compact', 'new Copilot chat every N turns'],
  ['/compact', 'start a new Copilot chat now'],
  ['/cwd', 'change the project directory'],
  ['/continue', 'resume .harness/session.json'],
  ['/verify', 'set a verification manifest'],
  ['/review', 'toggle the independent reviewer'],
  ['/skills', 'list .cursor/skills'],
  ['/skill <name>', 'use a skill for the next goal'],
  ['/search <query>', 'local BM25 repo search'],
  ['/index', 'build/update the local search index'],
  ['/image <path>', 'stage an image for the next goal'],
  ['/paste', 'paste a clipboard image (macOS)'],
  ['/status', 'show Edge / mode / session'],
  ['/login', 'launch Edge and wait for Copilot sign-in'],
  ['/probe', 'inspect Copilot selectors'],
  ['/clear', 'clear the transcript'],
  ['/help', 'show commands and shortcuts'],
  ['/quit', 'exit'],
];

function usage() {
  return [
    'Copilot Agent TUI - Codex CLI-style frontend for agent.js',
    '',
    'Usage:',
    '  node tui.mjs [options]',
    '',
    'Options:',
    '  --cwd <dir>        project directory (default: current directory)',
    '  --max-turns <n>    turn budget per goal (default: 40)',
    '  --auto-compact <n> new Copilot chat every N turns (default: 10)',
    '  --verify <file>    run manifest checks before accepting DONE',
    '  --review           opt-in independent reviewer after verification',
    '  --review-required  reviewer must return a valid result for done',
    '  --lang <code>      answer language: vi (default) or en',
    '  --no-review        disable a reviewer saved in the session',
    '  --print-progress <json>  render one status line without a TTY (tests)',
    '  --yolo             default: run without per-action approval',
    '  --safe | --ask     approve each action before it runs',
    '  --readonly         review mode: no project edits',
    '  --mock             use the local mock Copilot (headless Edge, no login)',
    '  --no-alt           do not use the alternate screen (debugging)',
    '  --help             show this help',
    '',
    'Inside the TUI:',
    '  Type a goal and press Enter. /help lists slash commands.',
    '  PgUp/PgDn scroll, Ctrl+V pastes a clipboard image, Ctrl+O toggles command details.',
    '',
    'The engine is agent.js: Edge Copilot writes bash, the harness runs it in',
    'the current directory and sends the output back until DONE/BLOCKED.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    maxTurns: 40,
    autoCompact: 10,
    yolo: true,
    readonly: false,
    mock: false,
    noAlt: false,
    help: false,
    verify: '',
    review: false,
    lang: process.env.HARNESS_LANG || 'vi',
    reviewRequired: false,
    printResult: '',
    printProgress: '',
  };
  const valueFlags = new Set(['--cwd', '--max-turns', '--auto-compact', '--verify', '--lang', '--print-result', '--print-progress']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--yolo') { opts.yolo = true; continue; }
    if (arg === '--safe' || arg === '--ask') { opts.yolo = false; continue; }
    if (arg === '--readonly' || arg === '--read-only') { opts.readonly = true; continue; }
    if (arg === '--review') { opts.review = true; continue; }
    if (arg === '--review-required') { opts.review = true; opts.reviewRequired = true; continue; }
    if (arg === '--no-review') { opts.review = false; opts.reviewRequired = false; opts.reviewOff = true; continue; }
    if (arg === '--mock') { opts.mock = true; continue; }
    if (arg === '--no-alt') { opts.noAlt = true; continue; }

    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : null;
    if (valueFlags.has(key)) {
      if (value == null) value = argv[++i];
      if (value == null) throw new Error(key + ' needs a value');
      if (key === '--cwd') opts.cwd = path.resolve(value);
      if (key === '--max-turns') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) throw new Error('--max-turns must be >= 1');
        opts.maxTurns = Math.floor(n);
      }
      if (key === '--auto-compact') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 2) throw new Error('--auto-compact must be >= 2');
        opts.autoCompact = Math.floor(n);
      }
      if (key === '--verify') opts.verify = value;
      if (key === '--lang') opts.lang = String(value).toLowerCase();
      if (key === '--print-result') opts.printResult = value;
      if (key === '--print-progress') opts.printProgress = value;
      continue;
    }
    throw new Error('unknown argument: ' + arg);
  }

  if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
    throw new Error('cwd is not a directory: ' + opts.cwd);
  }
  if (opts.verify) opts.verify = path.resolve(opts.cwd, opts.verify);
  return opts;
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\r/g, '')
    .replace(ANSI_RE, '')
    .replace(/\t/g, '  ');
}

function formatResultSummary(result) {
  if (!result || typeof result !== 'object') return '';
  const lines = [];
  const v = result.verification;
  if (v && Array.isArray(v.checks)) {
    const missing = v.checks.filter((c) => c.status !== 'passed');
    if (missing.length) {
      lines.push('Checks còn thiếu: ' + missing
        .map((c) => c.id + ' (' + c.status + (c.exitCode != null ? ', exit ' + c.exitCode : '') + ')')
        .join(', '));
    }
  }
  if (v && v.status && v.status !== 'passed' && v.status !== 'unconfigured'
    && !(v.checks || []).length) {
    lines.push('Verification: ' + v.status + (v.reason ? ' · ' + v.reason : ''));
  }
  const review = result.review;
  if (review && review.status && review.status !== 'skipped') {
    lines.push('Review: ' + review.status + (review.verdict ? ' · ' + review.verdict : '')
      + (review.findings && review.findings.length ? ' · ' + review.findings.length + ' finding(s)' : ''));
    for (const f of (review.findings || []).slice(0, 4)) lines.push('  - ' + f.issue);
  }
  if (result.canResume && result.status !== 'done') lines.push('Resume: /continue · .harness/session.json');
  return lines.join('\n');
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;

function readSkills(cwd) {
  const base = path.join(cwd, '.cursor', 'skills');
  if (!fs.existsSync(base)) return [];
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return []; }
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length >= 100) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'SKILL.md') {
        let real;
        try { real = fs.realpathSync(full); } catch { continue; }
        const relToBase = path.relative(realBase, real);
        if (!relToBase || relToBase.startsWith('..') || path.isAbsolute(relToBase)) continue;
        let text = '';
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
        let name = '';
        if (m) {
          const line = m[1].split('\n').find((l) => /^\s*name\s*:/.test(l));
          if (line) name = line.replace(/^\s*name\s*:\s*/, '').trim().replace(/^["']|["']$/g, '').trim();
        }
        if (!name) name = path.basename(path.dirname(full));
        found.push({ name, rel: path.relative(cwd, full).split(path.sep).join('/') });
      }
    }
  };
  walk(base, 0);
  const counts = {};
  for (const s of found) counts[s.name] = (counts[s.name] || 0) + 1;
  for (const s of found) s.label = counts[s.name] > 1 ? s.name + ' (' + s.rel + ')' : s.name;
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

function stageImage(cwd, src) {
  const abs = path.resolve(cwd, String(src || '').replace(/^~/, os.homedir()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('Ảnh không tồn tại: ' + abs);
  const st = fs.statSync(abs);
  if (st.size > 10 * 1024 * 1024) throw new Error('Ảnh quá lớn (max 10 MB): ' + abs);
  let rel = path.relative(cwd, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const dir = path.join(cwd, '.harness', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(abs));
    fs.copyFileSync(abs, dest);
    rel = path.relative(cwd, dest).split(path.sep).join('/');
  }
  return { abs, rel, bytes: st.size };
}

function clipboardImage(cwd) {
  if (process.platform !== 'darwin') {
    throw new Error('Paste clipboard chỉ hỗ trợ macOS. Dùng /image <path>.');
  }
  const dir = path.join(cwd, '.harness', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'clipboard-' + Date.now() + '.png');
  if (process.env.HARNESS_CLIPBOARD_IMAGE) {
    const src = path.resolve(process.env.HARNESS_CLIPBOARD_IMAGE);
    if (!fs.existsSync(src)) throw new Error('Clipboard image fixture không tồn tại: ' + src);
    fs.copyFileSync(src, out);
  } else {
    execFileSync('osascript', [
      '-e', 'set png to the clipboard as «class PNGf»',
      '-e', 'set f to open for access POSIX file ' + JSON.stringify(out) + ' with write permission',
      '-e', 'write png to f',
      '-e', 'close access f',
    ], { timeout: 8000 });
  }
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('Clipboard không có ảnh PNG.');
  }
  return { abs: out, rel: path.relative(cwd, out).split(path.sep).join('/'), bytes: fs.statSync(out).size };
}

function phaseStatusText({ phase, direction, verification, review, activeSummary, spinner, phaseElapsed, compact }) {
  const name = (phase && phase.name) || 'waiting';
  const label = (phase && phase.label) || PHASE_LABEL[name] || 'Đang chạy';
  const elapsed = phaseElapsed ? '  ·  ' + phaseElapsed : '';
  const spin = spinner || '⠋';
  const tail = compact ? '' : '  ·  esc stop  ·  ctrl+o details';
  if (name === 'verifying' && verification) {
    const missing = verification.missing || [];
    return label + '  ·  ' + (verification.passed || 0) + '/' + (verification.total || 0) + ' check đạt'
      + (missing.length ? (compact ? ' · còn ' : '  ·  còn ') + missing.join(', ') : '')
      + elapsed + (compact ? '' : '  ·  esc stop');
  }
  if (name === 'reviewing') {
    return label + elapsed
      + (review && review.findings && review.findings.length
        ? '  ·  ' + review.findings.length + ' finding(s)' : '')
      + (compact ? '' : '  ·  esc stop');
  }
  if (name === 'approval') {
    return label + elapsed + (compact ? '' : '  ·  a duyệt / x từ chối');
  }
  const what = name === 'running' ? (activeSummary || label) : label;
  return spin + ' ' + what + (direction ? '  ·  ' + direction : '') + elapsed + tail;
}

function wrapPlain(value, width) {
  const w = Math.max(10, width);
  const out = [];
  for (const raw of cleanText(value).split('\n')) {
    if (raw === '') { out.push(''); continue; }
    let rest = Array.from(raw);
    while (rest.length > w) {
      let cut = w;
      for (let i = w; i > Math.max(0, w - 24); i--) {
        if (rest[i] === ' ') { cut = i; break; }
      }
      out.push(rest.slice(0, cut).join(''));
      rest = rest.slice(cut);
      while (rest.length && rest[0] === ' ') rest = rest.slice(1);
    }
    out.push(rest.join(''));
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out.length ? out : [''];
}

function relHome(p) {
  const h = os.homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

function formatMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  return formatElapsed(ms);
}

function scriptSummary(script) {
  const lines = String(script || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l));
  if (!lines.length) return '(empty script)';
  let first = lines[0].replace(/^\$\s*/, '');
  if (first.length > 76) first = first.slice(0, 75) + '…';
  return lines.length > 1 ? first + '  +' + (lines.length - 1) : first;
}

function scriptNote(script) {
  for (const line of String(script || '').split('\n').slice(0, 6)) {
    const m = line.match(/^\s*#\s*note\s*:\s*(.+)$/i);
    if (m) return m[1].trim().slice(0, 180);
  }
  return '';
}

function readPlan(cwd) {
  try {
    const file = path.join(cwd, '.harness', 'PLAN.md');
    const text = fs.readFileSync(file, 'utf8');
    const items = [...text.matchAll(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/gm)];
    if (!items.length) return null;
    const open = items.filter((m) => m[1].toLowerCase() !== 'x').map((m) => m[2].trim());
    const done = items.length - open.length;
    return { done, total: items.length, open, next: open[0] || '' };
  } catch {
    return null;
  }
}

async function edgeStatus() {
  try {
    const res = await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false, version: '' };
    const data = await res.json();
    return { ok: true, version: data.Browser || 'Edge' };
  } catch {
    return { ok: false, version: '' };
  }
}

/* --------------------------------------------------------------- transcript */

function buildLines(blocks, width, opts) {
  const { details, spinner, now, running, activeStepId } = opts;
  const lines = [];

  const blank = () => {
    if (lines.length && lines[lines.length - 1].text !== '') {
      lines.push({ text: '', key: 'blank-' + lines.length });
    }
  };
  const push = (text, style, key) => {
    for (const line of wrapPlain(text, width)) {
      lines.push({ text: line, key: key + ':' + lines.length, ...style });
    }
  };
  const pushLines = (values, style, key, prefix, indent) => {
    values.forEach((value, i) => {
      const pre = i === 0 ? prefix : indent;
      push(pre + value, style, key);
    });
  };

  for (const block of blocks) {
    if (block.type === 'system') {
      push('· ' + block.text, { color: 'gray', dim: true }, 's' + block.id);
      continue;
    }
    if (block.type === 'info') {
      blank();
      pushLines(String(block.text || '').split('\n'), { color: 'gray' }, 'i' + block.id, '· ', '  ');
      continue;
    }
    if (block.type === 'warn') {
      blank();
      pushLines(String(block.text || '').split('\n'), { color: 'yellow' }, 'w' + block.id, '! ', '  ');
      continue;
    }
    if (block.type === 'error') {
      blank();
      pushLines(String(block.text || '').split('\n'), { color: 'red' }, 'e' + block.id, '✗ ', '  ');
      continue;
    }
    if (block.type === 'user') {
      blank();
      pushLines(String(block.text || '').split('\n'), { color: 'white', bold: true }, 'u' + block.id, '› ', '  ');
      continue;
    }
    if (block.type === 'attach') {
      blank();
      push('• Attached ' + block.file + (block.bytes ? ' (' + block.bytes + ' bytes)' : ''),
        { color: 'gray' }, 'a' + block.id);
      continue;
    }
    if (block.type === 'step') {
      blank();
      if (block.note) {
        push('· ' + block.note, { color: 'gray', dim: true }, 'n' + block.id);
      }
      const isActive = running && block.id === activeStepId && block.exit == null;
      const failed = block.exit != null && block.exit !== 0;
      const dur = isActive
        ? formatElapsed(now - block.startedAt)
        : (block.durationMs != null ? formatMs(block.durationMs) : '');
      const summary = scriptSummary(block.script);

      let head;
      let style;
      if (isActive) {
        head = spinner + ' Ran ' + summary + (dur ? '  ·  ' + dur : '');
        style = { color: 'yellow' };
      } else if (failed) {
        head = '✗ Ran ' + summary + (dur ? '  (' + dur + ', exit ' + block.exit + ')' : '  (exit ' + block.exit + ')');
        style = { color: 'red' };
      } else {
        head = '• Ran ' + summary + (dur ? '  (' + dur + ')' : '');
        style = {};
      }
      push(head, style, 'r' + block.id);

      const output = (block.output || []).filter((l) => l.trim() !== '');
      if (details) {
        const scriptLines = String(block.script || '').split('\n').slice(0, 16);
        if (scriptLines.length) {
          scriptLines.forEach((line, i) => {
            push((i === 0 ? '  $ ' : '    ') + line, { color: 'gray' }, 'd' + block.id);
          });
        }
        const max = 26;
        const shown = output.slice(-max);
        if (shown.length) {
          pushLines(shown, { color: 'gray', dim: true }, 'o' + block.id, '  └ ', '    ');
          if (output.length > max) {
            push('    … ' + (output.length - max) + ' more lines', { color: 'gray', dim: true }, 'm' + block.id);
          }
        }
        if (block.timing) {
          push('    timing: ' + block.timing, { color: 'gray', dim: true }, 't' + block.id);
        }
      } else {
        const max = isActive ? 3 : failed ? 6 : 1;
        const shown = output.slice(-max);
        if (shown.length) {
          pushLines(shown, { color: 'gray', dim: true }, 'o' + block.id, '  └ ', '    ');
          if (!running && !failed && output.length > 1) {
            // Keep one line visible; Ctrl+O reveals the rest.
          }
        }
      }
      continue;
    }
    if (block.type === 'final') {
      blank();
      let head;
      let color;
      if (block.status === 'done') {
        head = '✓ Done' + (block.turns ? ' · ' + block.turns + ' turn(s)' : '');
        color = 'green';
      } else if (block.status === 'blocked') {
        head = '! Blocked';
        color = 'yellow';
      } else if (block.status === 'partial') {
        head = '! Chưa hoàn tất · /continue để tiếp tục';
        color = 'yellow';
      } else if (block.status === 'cancelled') {
        head = '· Đã hủy · /continue để tiếp tục';
        color = 'gray';
      } else if (block.status === 'timed_out') {
        head = '! Hết thời gian · /continue để tiếp tục';
        color = 'yellow';
      } else {
        head = '✗ Failed';
        color = 'red';
      }
      push(head + (block.durationMs ? '  ·  ' + formatElapsed(block.durationMs) : ''),
        { color, bold: true }, 'f' + block.id);
      const summary = String(block.summary || '').split('\n').filter((l) => l.trim() !== '');
      for (const line of summary.slice(0, 12)) {
        push('  ' + line, { color: 'white' }, 'f' + block.id);
      }
      if (summary.length > 12) {
        push('  … ' + (summary.length - 12) + ' more lines', { color: 'gray', dim: true }, 'f' + block.id);
      }
      continue;
    }
  }

  while (lines.length && lines[lines.length - 1].text === '') lines.pop();
  return lines;
}

/* ---------------------------------------------------------------------- app */

function App({ opts }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [size, setSize] = useState(() => ({
    columns: stdout.columns || 100,
    rows: stdout.rows || 30,
  }));

  const welcomeBlocks = useCallback(() => {
    const list = [
      { id: 1, type: 'system', text: 'Copilot writes the commands; the harness runs them in this directory.' },
      { id: 2, type: 'system', text: 'Type a goal. /help for commands. Ctrl+O shows full commands and output.' },
    ];
    if (opts.readonly) list.push({ id: 3, type: 'info', text: 'Review mode is ON: no project edits.' });
    if (opts.mock) list.push({ id: 4, type: 'info', text: 'Mock Copilot is ON: no login needed.' });
    return list;
  }, [opts.readonly, opts.mock]);

  const [blocks, setBlocks] = useState(welcomeBlocks);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [mode, setMode] = useState(opts.yolo ? 'yolo' : 'ask');
  const [readonly, setReadonly] = useState(opts.readonly);
  const [mock, setMock] = useState(opts.mock);
  const [cwd, setCwd] = useState(opts.cwd);
  const [maxTurns, setMaxTurns] = useState(opts.maxTurns);
  const [autoCompact, setAutoCompact] = useState(opts.autoCompact);
  const [verify, setVerify] = useState(opts.verify || '');
  const [lang] = useState(opts.lang || 'vi');
  const [reviewMode, setReviewMode] = useState(opts.reviewOff ? 'off' : (opts.reviewRequired ? 'required' : (opts.review ? 'optional' : 'off')));
  const [edge, setEdge] = useState({ ok: null, version: '' });
  const [spinner, setSpinner] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  const [plan, setPlan] = useState(() => readPlan(opts.cwd));
  const [direction, setDirection] = useState('');
  const [phase, setPhase] = useState({ name: 'preparing', label: PHASE_LABEL.preparing, since: 0, detail: null });
  const [verification, setVerification] = useState(null);
  const [reviewInfo, setReviewInfo] = useState(null);
  const [skills, setSkills] = useState(() => readSkills(opts.cwd));
  const [pinnedSkill, setPinnedSkill] = useState('');
  const [pendingImage, setPendingImage] = useState(null);

  const idRef = useRef(10);
  const childRef = useRef(null);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const currentStepRef = useRef(null);
  const finalRef = useRef(0);
  const collectingRef = useRef(false);
  const summaryBufRef = useRef([]);
  const runStartRef = useRef(0);
  const approvalRef = useRef(null);
  const inputRef = useRef('');
  const cursorRef = useRef(0);
  const draftRef = useRef('');
  const quitTimer = useRef(null);
  const maxScrollRef = useRef(0);
  const pageRef = useRef(10);
  const liveRef = useRef({ cwd, mode, readonly, mock, maxTurns, autoCompact, verify, reviewMode, lang });
  liveRef.current = { cwd, mode, readonly, mock, maxTurns, autoCompact, verify, reviewMode, lang };
  const directionRef = useRef('');
  directionRef.current = direction;
  const eventTrackRef = useRef({ runId: null, seq: 0, terminal: false });
  const seenProgressRef = useRef(new Set());

  const setInputAt = useCallback((value, pos) => {
    const text = String(value == null ? '' : value);
    const at = Math.max(0, Math.min(text.length, pos == null ? text.length : pos));
    inputRef.current = text;
    cursorRef.current = at;
    setInput(text);
    setCursor(at);
  }, []);

  const addBlock = useCallback((block) => {
    const id = ++idRef.current;
    setBlocks((prev) => {
      const next = [...prev, { id, ...block }];
      return next.length > MAX_BLOCKS ? next.slice(-MAX_BLOCKS) : next;
    });
  }, []);

  const addFinal = useCallback((status, summary, turns) => {
    if (finalRef.current) return;
    finalRef.current = 1;
    const id = ++idRef.current;
    const durationMs = runStartRef.current ? Date.now() - runStartRef.current : 0;
    setBlocks((prev) => [...prev, {
      id,
      type: 'final',
      status,
      summary: String(summary || '').trim() || '(no summary)',
      turns,
      durationMs,
    }].slice(-MAX_BLOCKS));
  }, []);

  const refreshPlan = useCallback(() => {
    setPlan(readPlan(liveRef.current.cwd));
  }, []);

  useEffect(() => {
    setPlan(readPlan(cwd));
    setSkills(readSkills(cwd));
    setPinnedSkill('');
    setPendingImage(null);
  }, [cwd]);

  const refreshEdge = useCallback(async () => {
    const next = await edgeStatus();
    setEdge(next);
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = await edgeStatus();
      if (alive) setEdge(next);
    };
    tick();
    const timer = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setSpinner((s) => s + 1);
      setNow(Date.now());
    }, 140);
    return () => clearInterval(timer);
  }, [running]);

  const quit = useCallback(() => {
    if (quitTimer.current) clearTimeout(quitTimer.current);
    const child = childRef.current;
    if (child) { try { child.kill('SIGINT'); } catch {} }
    exit();
    setTimeout(() => process.exit(0), 250);
  }, [exit]);

  const cancel = useCallback(() => {
    const child = childRef.current;
    if (!child) return;
    cancelRef.current = true;
    addBlock({ type: 'warn', text: 'Stopping the agent…' });
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => {
      if (childRef.current === child) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 7000);
  }, [addBlock]);

  const runAgent = useCallback((spec = {}) => {
    if (runningRef.current) {
      addBlock({ type: 'warn', text: 'A run is already in progress. Press Esc or Ctrl+C to stop it.' });
      return;
    }
    // The agent emits the result marker before it disconnects Playwright and
    // exits. Once the result is in, the run is logically over; if the old child
    // is still cleaning up, stop it so a new run can start immediately.
    if (childRef.current) {
      try { childRef.current.kill('SIGINT'); } catch {}
      childRef.current = null;
    }

    const live = liveRef.current;
    const runCwd = live.cwd;
    let args;
    if (spec.login) {
      args = [AGENT, '--login'];
    } else if (spec.probe) {
      args = [AGENT, '--probe'];
    } else if (spec.newChat) {
      args = [AGENT, '--new-chat'];
    } else {
      args = [AGENT, '--json', '--events', '--trace-scripts', '--workdir', runCwd,
        '--max-turns', String(live.maxTurns), '--auto-compact', String(live.autoCompact),
        '--lang', live.lang];
      args.push('--' + (live.mode === 'safe' ? 'ask' : live.mode));
      if (live.readonly) args.push('--readonly');
      if (live.verify) args.push('--verify', live.verify);
      if (live.reviewMode === 'optional') args.push('--review');
      if (live.reviewMode === 'required') args.push('--review-required');
      if (live.reviewMode === 'off' && opts.reviewOff) args.push('--no-review');
      if (live.mock) args.push('--mock');
      if (spec.resume) args.push('--continue');
      else args.push(String(spec.goal || ''));
    }

    runningRef.current = true;
    cancelRef.current = false;
    currentStepRef.current = null;
    finalRef.current = 0;
    collectingRef.current = false;
    summaryBufRef.current = [];
    runStartRef.current = Date.now();
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setScroll(0);
    setSpinner(0);
    setDirection('');
    setPhase({ name: 'preparing', label: PHASE_LABEL.preparing, since: Date.now(), detail: null });
    setVerification(null);
    setReviewInfo(null);
    eventTrackRef.current = { runId: null, seq: 0, terminal: false };
    seenProgressRef.current = new Set();
    if (spec.login) addBlock({ type: 'info', text: 'Launching Edge and waiting for Copilot sign-in…' });
    if (spec.probe) addBlock({ type: 'info', text: 'Inspecting Copilot selectors…' });
    if (spec.newChat) addBlock({ type: 'info', text: 'Starting a new Copilot chat (memory stays in .harness)…' });

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: runCwd,
        env: { ...process.env, HARNESS_TUI: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      addFinal('error', 'Could not start agent.js: ' + error.message, 0);
      return;
    }
    childRef.current = child;

    let stdoutBuf = '';
    let stderrBuf = '';
    let result = null;

    const handleLine = (rawLine) => {
      const line = cleanText(rawLine);
      if (!line.trim()) return;

      if (line.startsWith('__HARNESS_EVENT__')) {
        try {
          const ev = JSON.parse(line.slice('__HARNESS_EVENT__'.length));
          if (!ev || ev.v !== 1 || !ev.runId) return;
          const track = eventTrackRef.current;
          if (track.runId && ev.runId !== track.runId) return;
          if (!track.runId) track.runId = ev.runId;
          if (typeof ev.seq === 'number') {
            if (ev.seq <= track.seq) return;
            track.seq = ev.seq;
          }
          if (track.terminal) return;
          if (ev.type === 'run.finished' || ev.type === 'run.info') {
            if (ev.type === 'run.finished') track.terminal = true;
          }

          if (ev.type === 'progress.intent') {
            const p = ev.payload || {};
            const nextDirection = p.milestone || p.intent || '';
            if (nextDirection) setDirection(nextDirection);
            if (p.changeReason) {
              const key = 'change:' + p.changeReason;
              if (!seenProgressRef.current.has(key)) {
                seenProgressRef.current.add(key);
                addBlock({
                  type: 'info',
                  text: 'Đổi hướng · ' + p.changeReason + (p.milestone ? ' · ' + p.milestone : ''),
                });
              }
            } else if (p.milestone && p.milestone !== directionRef.current) {
              const key = 'milestone:' + p.milestone;
              if (!seenProgressRef.current.has(key)) {
                seenProgressRef.current.add(key);
                addBlock({ type: 'system', text: 'Mốc · ' + p.milestone });
              }
            }
          } else if (ev.type === 'progress.phase') {
            const p = ev.payload || {};
            setPhase({
              name: p.phase,
              label: PHASE_LABEL[p.phase] || p.phase,
              since: Date.now(),
              detail: p,
            });
            if (p.direction) setDirection(p.direction);
          } else if (ev.type === 'progress.verification') {
            const p = ev.payload || {};
            setVerification(p);
            const missing = p.missing || [];
            const key = 'verify:' + (p.status || '') + ':' + (p.revision || '') + ':' + missing.join(',');
            if (!seenProgressRef.current.has(key)
              && (p.status === 'failed' || p.status === 'stale' || p.status === 'unavailable'
                || p.status === 'passed' || missing.length)) {
              seenProgressRef.current.add(key);
              const total = p.total == null ? 0 : p.total;
              const passed = p.passed == null ? 0 : p.passed;
              addBlock({
                type: p.status === 'passed' ? 'system' : 'info',
                text: 'Xác minh · ' + passed + '/' + total + ' check đạt'
                  + (missing.length ? ' · còn ' + missing.join(', ') : '')
                  + (p.status && p.status !== 'passed' ? ' · ' + p.status : ''),
              });
            }
          } else if (ev.type === 'review.result') {
            const p = ev.payload || {};
            setReviewInfo(p);
            if (p.status === 'reviewed') {
              addBlock({
                type: 'info',
                text: 'Review độc lập · ' + (p.verdict === 'ok'
                  ? 'ok'
                  : (p.findings || []).length + ' finding(s)'),
              });
            } else if (p.status && p.status !== 'skipped') {
              addBlock({ type: 'info', text: 'Review độc lập · ' + p.status + (p.reason ? ' · ' + p.reason : '') });
            }
          } else if (ev.type === 'approval.requested') {
            approvalRef.current = ev.payload || {};
            const p = ev.payload || {};
            const head = p.kind === 'bash'
              ? 'Cần xác nhận · Chạy bash  [a] duyệt · [x] từ chối'
              : p.kind === 'verify'
                ? 'Cần xác nhận · Verification  [a] duyệt · [x] từ chối'
                : p.kind === 'tool'
                  ? 'Cần xác nhận · Tool ' + (p.tool || '') + '  [a] duyệt · [x] từ chối'
                  : 'Cần xác nhận · Gửi file  [a] duyệt · [x] từ chối';
            const detail = p.kind === 'bash'
              ? String(p.script || '').split('\n').slice(0, 6).join('\n')
              : p.kind === 'verify'
                ? (p.manifest || '') + ' · ' + (p.checks || []).join(', ')
                : p.kind === 'tool'
                  ? JSON.stringify(p.args || {}).slice(0, 600)
                  : (p.file || '') + ' (' + (p.bytes || 0) + ' bytes)';
            addBlock({ type: 'info', text: head + '\n  ' + detail });
          } else if (ev.type === 'approval.granted' || ev.type === 'approval.denied') {
            approvalRef.current = null;
          }
        } catch {}
        return;
      }

      if (line.startsWith('__HARNESS_RESULT__')) {
        try {
          result = JSON.parse(line.slice('__HARNESS_RESULT__'.length));
          collectingRef.current = false;
          const statusMap = { blocked: 'blocked', error: 'error', partial: 'partial', cancelled: 'cancelled', timed_out: 'timed_out' };
          const status = statusMap[result.status] || 'done';
          const extra = formatResultSummary(result);
          const summary = [result.summary || result.message || summaryBufRef.current.join('\n'), extra]
            .filter(Boolean).join('\n');
          addFinal(status, summary
            + (result.reason && result.status !== 'done' ? '\nreason: ' + result.reason : ''),
          result.turns);
          // The result is authoritative; Playwright/Edge cleanup happens after
          // this marker. Release the UI now instead of waiting for process exit.
          runningRef.current = false;
          currentStepRef.current = null;
          setRunning(false);
          refreshPlan();
        } catch {}
        return;
      }
      if (line.startsWith('__HARNESS_COMPACT__')) {
        try {
          const data = JSON.parse(line.slice('__HARNESS_COMPACT__'.length));
          if (data.phase === 'request') {
            addBlock({
              type: 'info',
              text: '↻ Compacting context: asking Copilot for a handoff summary…',
            });
          } else {
            addBlock({
              type: 'info',
              text: '↻ New Copilot chat ready'
                + (data.chars ? ' · handoff summary ' + data.chars + ' chars carried over.'
                  : ' · memory carried in .harness.'),
            });
          }
          refreshPlan();
        } catch {}
        return;
      }
      if (line.startsWith('__HARNESS_SCRIPT__')) {
        try {
          const data = JSON.parse(line.slice('__HARNESS_SCRIPT__'.length));
          const id = ++idRef.current;
          currentStepRef.current = id;
          setBlocks((prev) => [...prev, {
            id,
            type: 'step',
            turn: data.turn,
            script: data.script || '',
            note: scriptNote(data.script),
            output: [],
            exit: null,
            durationMs: null,
            timing: '',
            startedAt: Date.now(),
          }].slice(-MAX_BLOCKS));
        } catch {}
        return;
      }

      if (collectingRef.current) {
        summaryBufRef.current.push(line);
        return;
      }
      if (/^=== GOAL COMPLETE ===$/.test(line)) {
        collectingRef.current = true;
        summaryBufRef.current = [];
        return;
      }
      if (/^=== GOAL BLOCKED ===$/.test(line)) {
        collectingRef.current = true;
        summaryBufRef.current = [];
        return;
      }
      if (/^--- turn \d+ ---$/.test(line)) return;

      if (/^  \. /.test(line)) {
        const id = currentStepRef.current;
        if (!id) return;
        const text = line.slice(4);
        setBlocks((prev) => prev.map((b) => {
          if (b.id !== id || b.type !== 'step') return b;
          const output = [...b.output, text];
          return { ...b, output: output.length > MAX_OUTPUT_LINES ? output.slice(-MAX_OUTPUT_LINES) : output };
        }));
        return;
      }

      let m = line.match(/^exit=(\d+) in (\d+)ms/);
      if (m) {
        const id = currentStepRef.current;
        if (id) {
          setBlocks((prev) => prev.map((b) => b.id === id && b.type === 'step'
            ? { ...b, exit: Number(m[1]), durationMs: Number(m[2]) }
            : b));
        }
        setTimeout(refreshPlan, 20);
        return;
      }
      if (/^timing:/.test(line)) {
        const id = currentStepRef.current;
        if (id) {
          const value = line.replace(/^timing:\s*/, '');
          setBlocks((prev) => prev.map((b) => b.id === id && b.type === 'step'
            ? { ...b, timing: value }
            : b));
        }
        return;
      }

      m = line.match(/^attached: (.+?) \((\d+) bytes\)/);
      if (m) {
        addBlock({ type: 'attach', file: m[1], bytes: Number(m[2]) });
        return;
      }

      if (/^WARN(?:ING)?\b/.test(line)) { addBlock({ type: 'warn', text: line }); return; }
      if (/^(FATAL|ERROR)\b/.test(line)) { addBlock({ type: 'error', text: line }); return; }

      if (spec.login) {
        if (/^(LAUNCH|PROFILE|WAITING|PAGE|LOGIN|Next:)/.test(line)) {
          addBlock({ type: 'info', text: line });
        }
        return;
      }
      if (spec.probe) {
        addBlock({ type: 'info', text: line });
        return;
      }
      if (spec.newChat) {
        if (/^(NEW CHAT|RESET|PAGE|WAITING)/.test(line)) {
          addBlock({ type: 'info', text: line });
        }
        return;
      }

      // Everything else is harness plumbing (PAGE, POLICY, connecting, mock,
      // script counts, git snapshots, ...). Keep the Codex-like transcript
      // clean; use --json/logs when debugging.
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim()) addBlock({ type: 'error', text: line });
      }
    });

    child.on('error', (error) => {
      runningRef.current = false;
      childRef.current = null;
      setRunning(false);
      addFinal('error', 'agent.js error: ' + error.message, 0);
    });

    child.on('close', (code, signal) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (stderrBuf.trim()) addBlock({ type: 'error', text: stderrBuf });
      stdoutBuf = '';
      stderrBuf = '';
      childRef.current = null;
      runningRef.current = false;
      currentStepRef.current = null;
      setRunning(false);
      setNow(Date.now());

      if (cancelRef.current) {
        cancelRef.current = false;
        addBlock({ type: 'warn', text: 'Run cancelled' + (signal ? ' (' + signal + ')' : '') + '.' });
      } else if (spec.login) {
        addBlock({ type: code === 0 ? 'info' : 'error', text: code === 0 ? 'Login complete.' : 'Login exited with code ' + code + '.' });
      } else if (spec.probe) {
        addBlock({ type: code === 0 ? 'info' : 'error', text: code === 0 ? 'Probe complete.' : 'Probe exited with code ' + code + '.' });
      } else if (spec.newChat) {
        addBlock({ type: code === 0 ? 'info' : 'error', text: code === 0 ? 'New Copilot chat ready.' : 'New chat failed with code ' + code + '.' });
      } else if (!finalRef.current) {
        const summary = summaryBufRef.current.join('\n').trim();
        addFinal(code === 0 ? 'done' : 'error', summary || (code === 0 ? '(no summary)' : 'Agent exited with code ' + code + '.'), result && result.turns);
      }
      collectingRef.current = false;
      refreshPlan();
      refreshEdge().catch(() => {});
    });
  }, [addBlock, addFinal, refreshEdge, refreshPlan]);

  const handleCommand = useCallback((raw) => {
    const text = String(raw || '').trim();
    const [cmdRaw, ...restParts] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = restParts.join(' ').trim();

    if (cmd === '/help') {
      addBlock({
        type: 'info',
        text: [
          'Commands:',
          '  /safe | /yolo     execution policy for the next run',
          '  /readonly         toggle review mode',
          '  /mock             toggle local mock Copilot',
          '  /max <n>          turn budget per goal',
          '  /auto-compact <n> new Copilot chat every N turns',
          '  /compact          start a new Copilot chat now',
          '  /cwd <path>       change project directory',
          '  /continue         resume <cwd>/.harness/session.json',
          '  /skills           list .cursor/skills',
          '  /skill <name>     use a skill for the next goal',
          '  /search <query>   local BM25 repo search',
          '  /index            build/update local search index',
          '  /image <path>     stage an image for the next goal',
          '  /paste            paste a clipboard image (macOS)',
          '  /status           Edge, mode, cwd, session',
          '  /login            launch Edge and sign in',
          '  /probe            inspect Copilot selectors',
          '  /clear            clear transcript',
          '  /quit             exit',
          '',
          'Keys: Enter send · Ctrl+V paste ảnh · PgUp/PgDn scroll · Esc stop/clear · Ctrl+O details · Ctrl+X quit',
        ].join('\n'),
      });
      return;
    }
    if (cmd === '/safe' || cmd === '/ask') { setMode('ask'); addBlock({ type: 'info', text: 'Mode: ask · duyệt từng hành động.' }); return; }
    if (cmd === '/yolo') { setMode('yolo'); addBlock({ type: 'info', text: 'Mode: yolo · chạy thẳng, không hỏi duyệt (deny list vẫn bật).' }); return; }
    if (cmd === '/preview') { setMode('preview'); addBlock({ type: 'info', text: 'Mode: preview · chỉ đề xuất, không chạy lệnh.' }); return; }
    if (cmd === '/readonly') {
      setReadonly((v) => {
        addBlock({ type: 'info', text: 'Review mode: ' + (!v ? 'ON (no project edits).' : 'off.') });
        return !v;
      });
      return;
    }
    if (cmd === '/mock') {
      setMock((v) => {
        addBlock({ type: 'info', text: 'Mock Copilot: ' + (!v ? 'ON.' : 'off.') });
        return !v;
      });
      return;
    }
    if (cmd === '/max') {
      if (!arg) { addBlock({ type: 'info', text: 'Turn budget: ' + maxTurns + '. Use /max <n>.' }); return; }
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 1) { addBlock({ type: 'error', text: 'Usage: /max <positive integer>' }); return; }
      setMaxTurns(Math.floor(n));
      addBlock({ type: 'info', text: 'Turn budget: ' + Math.floor(n) + '.' });
      return;
    }
    if (cmd === '/auto-compact') {
      if (!arg) { addBlock({ type: 'info', text: 'Auto-compact: every ' + autoCompact + ' turns. Use /auto-compact <n>.' }); return; }
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 2) { addBlock({ type: 'error', text: 'Usage: /auto-compact <integer >= 2>' }); return; }
      setAutoCompact(Math.floor(n));
      addBlock({ type: 'info', text: 'Auto-compact: new Copilot chat every ' + Math.floor(n) + ' turns (memory kept).' });
      return;
    }
    if (cmd === '/compact') {
      runAgent({ newChat: true });
      return;
    }
    if (cmd === '/cwd') {
      if (!arg) { addBlock({ type: 'info', text: 'cwd: ' + cwd }); return; }
      const next = path.resolve(arg.startsWith('~') ? arg.replace(/^~/, os.homedir()) : arg);
      if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
        addBlock({ type: 'error', text: 'Not a directory: ' + next });
        return;
      }
      setCwd(next);
      addBlock({ type: 'info', text: 'cwd: ' + next });
      return;
    }
    if (cmd === '/continue') {
      if (!fs.existsSync(path.join(cwd, '.harness', 'session.json'))) {
        addBlock({ type: 'warn', text: 'No session at ' + path.join(cwd, '.harness', 'session.json') + '.' });
        return;
      }
      runAgent({ resume: true });
      return;
    }
    if (cmd === '/skills') {
      const list = readSkills(cwd);
      addBlock({
        type: 'info',
        text: list.length
          ? 'Skills:\n' + list.map((s) => '  ' + s.label + '  ·  ' + s.rel).join('\n')
          : 'Không có skill trong .cursor/skills.',
      });
      return;
    }
    if (cmd === '/skill') {
      if (!arg) {
        addBlock({ type: 'info', text: 'Dùng: /skill <name>. Xem /skills.' });
        return;
      }
      const list = readSkills(cwd);
      const found = list.find((s) => s.label.toLowerCase() === arg.toLowerCase())
        || list.find((s) => s.name.toLowerCase() === arg.toLowerCase());
      if (!found) {
        addBlock({ type: 'error', text: 'Không thấy skill: ' + arg + '. Dùng /skills.' });
        return;
      }
      setPinnedSkill(found.name);
      addBlock({ type: 'info', text: 'Skill cho goal tiếp theo: ' + found.label });
      return;
    }
    if (cmd === '/search') {
      if (!arg) {
        addBlock({ type: 'info', text: 'Dùng: /search <query>. Ví dụ /search khôi phục phiên' });
        return;
      }
      const result = repoSearch.search(cwd, { query: arg, strategy: 'auto', limit: 5 });
      if (!result.ok) {
        addBlock({ type: 'error', text: result.error || 'search failed' });
        return;
      }
      const hits = result.data.hits || [];
      addBlock({
        type: 'info',
        text: hits.length
          ? 'Search · ' + result.data.strategy + ' · ' + result.data.index.files + ' files\n'
            + hits.map((h, i) => '  ' + (i + 1) + '. ' + h.path + ':' + h.from + '-' + h.to
              + (h.symbol ? ' · ' + h.symbol : '') + '  (' + h.reason + ')').join('\n')
          : 'Search: không có hit. Thử query ngắn hơn hoặc /index.',
      });
      return;
    }
    if (cmd === '/index') {
      const result = repoSearch.search(cwd, { query: 'index', limit: 1, buildTimeoutMs: 15000 });
      addBlock({
        type: 'info',
        text: result.ok
          ? 'Index: ' + result.data.index.files + ' files · changed '
            + result.data.index.changed + ' · ' + result.data.index.durationMs + 'ms'
          : 'Index lỗi: ' + (result.error || 'unknown'),
      });
      return;
    }
    if (cmd === '/image') {
      if (!arg) {
        addBlock({ type: 'info', text: 'Dùng: /image <path>. Ảnh sẽ được gửi kèm goal tiếp theo.' });
        return;
      }
      if (!IMAGE_RE.test(arg)) {
        addBlock({ type: 'warn', text: 'Không phải đuôi ảnh thông dụng: ' + arg });
      }
      try {
        const img = stageImage(cwd, arg);
        setPendingImage(img);
        addBlock({ type: 'info', text: 'Ảnh chờ gửi: ' + img.rel + ' (' + img.bytes + ' bytes)' });
      } catch (error) {
        addBlock({ type: 'error', text: error.message });
      }
      return;
    }
    if (cmd === '/paste') {
      try {
        const img = clipboardImage(cwd);
        setPendingImage(img);
        addBlock({ type: 'info', text: 'Đã dán ảnh: ' + img.rel + ' (' + img.bytes + ' bytes)' });
      } catch (error) {
        addBlock({ type: 'error', text: error.message });
      }
      return;
    }
    if (cmd === '/status') {
      addBlock({ type: 'info', text: 'cwd: ' + cwd + ' · mode: ' + mode + (readonly ? ' · review' : '') + (mock ? ' · mock' : '') + ' · max: ' + maxTurns + (verify ? ' · verify: ' + verify : '') + ' · reviewer: ' + reviewMode });
      refreshEdge().then((e) => {
        addBlock({ type: 'info', text: 'Edge: ' + (e.ok ? 'connected (' + e.version + ')' : 'offline · run /login') });
      }).catch(() => {});
      const session = path.join(cwd, '.harness', 'session.json');
      addBlock({ type: 'system', text: 'session: ' + session + (fs.existsSync(session) ? ' (exists)' : ' (none)') });
      return;
    }
    if (cmd === '/review') {
      const next = reviewMode === 'off' ? 'optional' : reviewMode === 'optional' ? 'required' : 'off';
      setReviewMode(next);
      addBlock({ type: 'info', text: 'reviewer: ' + next });
      return;
    }
    if (cmd === '/verify') {
      if (!arg) {
        addBlock({ type: 'info', text: 'verify: ' + (verify || '(none)') });
        return;
      }
      const target = path.resolve(cwd, arg);
      if (!fs.existsSync(target)) {
        addBlock({ type: 'error', text: 'Manifest not found: ' + target });
        return;
      }
      setVerify(target);
      addBlock({ type: 'info', text: 'verify manifest: ' + target });
      return;
    }
    if (cmd === '/login') { runAgent({ login: true }); return; }
    if (cmd === '/probe') { runAgent({ probe: true }); return; }
    if (cmd === '/clear') { setBlocks(welcomeBlocks()); setScroll(0); return; }
    if (cmd === '/quit' || cmd === '/exit') { quit(); return; }
    addBlock({ type: 'error', text: 'Unknown command: ' + cmd + '. Try /help.' });
  }, [addBlock, autoCompact, cwd, maxTurns, mode, mock, readonly, refreshEdge, reviewMode, runAgent, quit, verify, welcomeBlocks]);

  const slashItems = useMemo(() => [
    ...SLASH,
    ...skills.map((s) => ['/skill ' + s.name, 'dùng skill ' + s.label]),
  ], [skills]);

  const suggestions = useMemo(() => {
    if (running || !input.startsWith('/')) return [];
    if (/^\/skill\s+/i.test(input)) {
      const q = input.replace(/^\/skill\s+/i, '').toLowerCase();
      return skills
        .filter((s) => s.name.toLowerCase().startsWith(q) || s.label.toLowerCase().startsWith(q))
        .slice(0, 6)
        .map((s) => ['/skill ' + s.name, 'dùng skill ' + s.label]);
    }
    if (/\s/.test(input)) return [];
    return slashItems.filter(([cmd]) => cmd.startsWith(input)).slice(0, 6);
  }, [input, running, slashItems, skills]);

  const submit = useCallback((forced) => {
    if (runningRef.current) return;
    const source = typeof forced === 'string' ? forced : inputRef.current;
    const raw = source.replace(/\s+$/, '');
    if (!raw.trim()) return;

    setInputAt('', 0);
    setScroll(0);
    setQuitArmed(false);
    if (quitTimer.current) clearTimeout(quitTimer.current);

    if (raw.trim().startsWith('/')) {
      handleCommand(raw.trim());
      return;
    }
    let goal = raw.trim();
    const attach = [];
    if (pinnedSkill) {
      goal = 'Use skill ' + pinnedSkill + '.\n\n' + goal;
      attach.push('skill ' + pinnedSkill);
    }
    if (pendingImage) {
      goal += '\n\nIMAGE TO ATTACH: ' + pendingImage.rel
        + '\nUpload this image with the ATTACH protocol before other work.';
      attach.push('ảnh ' + pendingImage.rel);
    }
    addBlock({ type: 'user', text: raw });
    if (attach.length) addBlock({ type: 'info', text: 'Đã gắn: ' + attach.join(' · ') });
    setHistory((prev) => [...prev, raw].slice(-100));
    setHistIdx(-1);
    draftRef.current = '';
    setPinnedSkill('');
    setPendingImage(null);
    runAgent({ goal });
  }, [addBlock, handleCommand, pendingImage, pinnedSkill, runAgent, setInputAt]);

  useInput((ch, key) => {
    // Approval answers have priority while a decision is pending.
    if (approvalRef.current && runningRef.current && !key.ctrl && (ch === 'a' || ch === 'x')) {
      const approve = ch === 'a';
      const child = childRef.current;
      approvalRef.current = null;
      addBlock({ type: 'system', text: approve ? '→ Đã duyệt hành động này.' : '→ Đã từ chối · hành động chưa chạy.' });
      if (child && child.stdin && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ approve }) + '\n');
      }
      return;
    }
    if ((key.ctrl || key.meta) && (ch === 'v' || ch === '\x16')) {
      try {
        const img = clipboardImage(liveRef.current.cwd);
        setPendingImage(img);
        addBlock({ type: 'info', text: 'Đã dán ảnh: ' + img.rel + ' (' + img.bytes + ' bytes)' });
      } catch (error) {
        addBlock({ type: 'error', text: error.message });
      }
      return;
    }
    if (key.ctrl && ch === 'o') {
      setDetails((v) => !v);
      return;
    }
    if (key.ctrl && ch === 'x') {
      quit();
      return;
    }
    if (key.ctrl && (ch === 'q' || ch === 'd')) {
      quit();
      return;
    }
    if (key.pageUp) {
      setScroll((s) => Math.min(maxScrollRef.current, s + pageRef.current));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => Math.max(0, s - pageRef.current));
      return;
    }
    if (key.ctrl && ch === 'c') {
      if (runningRef.current) cancel();
      else if (inputRef.current) { setInputAt('', 0); setQuitArmed(false); }
      else if (quitArmed) quit();
      else {
        setQuitArmed(true);
        addBlock({ type: 'system', text: 'Press Ctrl+C again to quit.' });
        if (quitTimer.current) clearTimeout(quitTimer.current);
        quitTimer.current = setTimeout(() => setQuitArmed(false), 2500);
      }
      return;
    }
    if (key.escape) {
      if (runningRef.current) cancel();
      else if (inputRef.current) setInputAt('', 0);
      return;
    }
    if (runningRef.current) return;
    if (quitArmed) setQuitArmed(false);

    if (key.return) { submit(); return; }
    if (ch === '\r' || ch === '\n') { submit(); return; }
    if (ch && /[\r\n]/.test(ch)) {
      const text = ch.replace(/[\r\n]+/g, ' ');
      submit(inputRef.current.slice(0, cursorRef.current) + text + inputRef.current.slice(cursorRef.current));
      return;
    }
    if (key.ctrl && ch === 'l') { setBlocks(welcomeBlocks()); setScroll(0); return; }
    if (key.ctrl && ch === 'u') { setInputAt('', 0); return; }

    if (key.upArrow) {
      if (!history.length) return;
      let idx;
      if (histIdx === -1) { draftRef.current = inputRef.current; idx = history.length - 1; }
      else idx = Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInputAt(history[idx], history[idx].length);
      return;
    }
    if (key.downArrow) {
      if (histIdx === -1) return;
      if (histIdx >= history.length - 1) {
        setHistIdx(-1);
        setInputAt(draftRef.current, draftRef.current.length);
      } else {
        const idx = histIdx + 1;
        setHistIdx(idx);
        setInputAt(history[idx], history[idx].length);
      }
      return;
    }
    if (key.leftArrow) { setInputAt(inputRef.current, Math.max(0, cursorRef.current - 1)); return; }
    if (key.rightArrow) { setInputAt(inputRef.current, Math.min(inputRef.current.length, cursorRef.current + 1)); return; }
    if (key.home) { setInputAt(inputRef.current, 0); return; }
    if (key.end) { setInputAt(inputRef.current, inputRef.current.length); return; }
    if (key.backspace) {
      const cur = cursorRef.current;
      if (cur > 0) {
        setInputAt(inputRef.current.slice(0, cur - 1) + inputRef.current.slice(cur), cur - 1);
        setHistIdx(-1);
      }
      return;
    }
    if (key.delete) {
      const cur = cursorRef.current;
      if (cur < inputRef.current.length) {
        setInputAt(inputRef.current.slice(0, cur) + inputRef.current.slice(cur + 1), cur);
        setHistIdx(-1);
      }
      return;
    }
    if (key.tab || key.meta || key.ctrl) return;

    if (ch) {
      const text = ch.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (!text) return;
      const cur = cursorRef.current;
      if (inputRef.current.length + text.length > 12000) return;
      setInputAt(inputRef.current.slice(0, cur) + text + inputRef.current.slice(cur), cur + text.length);
      setHistIdx(-1);
    }
  });

  useEffect(() => () => {
    if (quitTimer.current) clearTimeout(quitTimer.current);
    if (childRef.current) { try { childRef.current.kill('SIGINT'); } catch {} }
  }, []);

  /* layout */
  const rows = Math.max(8, size.rows || 30);
  const cols = Math.max(20, size.columns || 100);
  const suggestHeight = suggestions.length;
  const inputWidth = Math.max(20, cols - 6);
  const inputWrapped = wrapPlain(input ? input + ' ' : ' ', inputWidth);
  const maxInputLines = Math.max(1, rows - 1 - 1 - 1 - 2 - suggestHeight - 3);
  const inputLines = running ? 1 : Math.min(6, maxInputLines, inputWrapped.length);
  const inputHeight = inputLines + 2;
  const transcriptHeight = Math.max(3, rows - 1 - 1 - 1 - suggestHeight - inputHeight);

  const activeStep = blocks.find((b) => b.type === 'step' && b.id === currentStepRef.current);
  const activeSummary = activeStep ? scriptSummary(activeStep.script) : 'Thinking with Copilot';
  const displayLines = useMemo(() => buildLines(blocks, cols - 2, {
    details,
    spinner: SPIN[spinner % SPIN.length],
    now,
    running,
    activeStepId: currentStepRef.current,
  }), [blocks, cols, details, spinner, now, running, activeStep ? activeStep.id : 0]);

  const maxScroll = Math.max(0, displayLines.length - transcriptHeight);
  maxScrollRef.current = maxScroll;
  pageRef.current = Math.max(2, transcriptHeight - 2);
  const shownScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, displayLines.length - transcriptHeight - shownScroll);
  const visible = displayLines.slice(start, start + transcriptHeight);

  const elapsed = running && startedAt ? formatElapsed(now - startedAt) : '';
  const modeColor = mode === 'yolo' ? 'red' : 'green';
  const edgeColor = edge.ok === null ? 'gray' : edge.ok ? 'green' : 'red';
  const edgeLabel = edge.ok === null ? '⋯ edge' : edge.ok ? '● edge' : '○ edge';
  const modeLabel = mode + (readonly ? ' · review' : '') + (mock ? ' · mock' : '');

  const planBar = plan
    ? '▰'.repeat(Math.round((plan.done / plan.total) * 6))
      + '▱'.repeat(6 - Math.round((plan.done / plan.total) * 6))
    : '';

  let progress;
  let progressColor = 'gray';
  const phaseElapsed = phase.since ? formatElapsed(now - phase.since) : elapsed;
  if (running) {
    progress = phaseStatusText({
      phase,
      direction,
      verification,
      review: reviewInfo,
      activeSummary,
      spinner: SPIN[spinner % SPIN.length],
      phaseElapsed,
      compact: cols < 70,
    });
    progressColor = 'yellow';
  } else if (!edge.ok && !mock) {
    progress = 'edge offline  ·  /login to launch it';
    progressColor = 'yellow';
  } else if (plan) {
    progress = 'Plan  ' + planBar + '  ' + plan.done + '/' + plan.total
      + (plan.next ? '  ·  next: ' + plan.next.slice(0, 52) : '');
    progressColor = 'gray';
  } else {
    progress = 'ready  ·  ⏎ send  ·  ctrl+v dán ảnh  ·  /help  ·  ctrl+o details';
  }
  if (shownScroll > 0) {
    if (cols < 80) progress = '↑' + shownScroll + '  ·  ' + progress;
    else progress += '  ·  ↑' + shownScroll;
  }

  const inputChildren = [];
  inputChildren.push(React.createElement(Text, { key: 'p', dimColor: true }, '› '));
  if (running) {
    inputChildren.push(React.createElement(Text, { key: 'r', color: 'yellow' },
      SPIN[spinner % SPIN.length] + ' Copilot is working…  Esc to stop'));
  } else if (input) {
    inputChildren.push(React.createElement(Text, { key: 'b' }, input.slice(0, cursor)));
    inputChildren.push(React.createElement(Text, { key: 'c', inverse: true }, input[cursor] || ' '));
    inputChildren.push(React.createElement(Text, { key: 'a' }, input.slice(cursor + 1)));
  } else {
    inputChildren.push(React.createElement(Text, { key: 'c', inverse: true }, ' '));
    inputChildren.push(React.createElement(Text, { key: 'h', dimColor: true }, ' Ask Copilot to do something…'));
  }

  return React.createElement(Box, { flexDirection: 'column', width: '100%', height: rows },
    React.createElement(Box, { height: 1, paddingX: 1 },
      React.createElement(Text, { wrap: 'truncate' },
        React.createElement(Text, { bold: true }, 'copilot-harness'),
        React.createElement(Text, { dimColor: true }, ' · Edge' + (mock ? ' (mock)' : '') + ' · agent.js')
      )
    ),

    React.createElement(Box, {
      flexDirection: 'column',
      height: transcriptHeight,
      paddingX: 1,
      overflow: 'hidden',
    },
      visible.length
        ? visible.map((line) => React.createElement(Text, {
            key: line.key,
            wrap: 'truncate',
            color: line.color,
            dimColor: line.dim,
            bold: line.bold,
          }, line.text || ' '))
        : React.createElement(Text, { dimColor: true }, 'No output yet. Type a goal below.')
    ),

    React.createElement(Box, { height: 1, paddingX: 1 },
      React.createElement(Text, { wrap: 'truncate', color: progressColor }, progress)
    ),

    suggestions.length
      ? React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
          suggestions.map(([cmd, desc]) => React.createElement(Text, { key: cmd },
            React.createElement(Text, { bold: true }, cmd.padEnd(13)),
            React.createElement(Text, { dimColor: true }, desc)
          ))
        )
      : null,

    React.createElement(Box, {
      height: inputHeight,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: running ? 'gray' : quitArmed ? 'red' : 'gray',
      overflow: 'hidden',
    },
      React.createElement(Text, { wrap: 'wrap' }, ...inputChildren)
    ),

    React.createElement(Box, { height: 1, paddingX: 1 },
      React.createElement(Text, { wrap: 'truncate' },
        React.createElement(Text, { dimColor: true }, relHome(cwd) + '  ·  '),
        React.createElement(Text, { bold: true }, modeLabel),
        React.createElement(Text, { dimColor: true }, '  ·  '),
        React.createElement(Text, { dimColor: true }, edgeLabel),
        React.createElement(Text, { dimColor: true }, '      ^O ' + (details ? 'collapse' : 'details') + '  ·  ^X quit')
      )
    )
  );
}

/* --------------------------------------------------------------------- main */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('ERROR: ' + error.message + '\n\n' + usage() + '\n');
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!fs.existsSync(AGENT)) {
    process.stderr.write('ERROR: agent.js not found at ' + AGENT + '\n');
    process.exit(1);
  }
  if (opts.printProgress) {
    let data;
    try {
      data = JSON.parse(opts.printProgress);
    } catch (error) {
      process.stderr.write('ERROR: --print-progress needs valid JSON: ' + error.message + '\n');
      process.exit(2);
    }
    process.stdout.write(phaseStatusText({
      phase: data.phase || { name: 'waiting', label: PHASE_LABEL.waiting },
      direction: data.direction || '',
      verification: data.verification || null,
      review: data.review || null,
      activeSummary: data.activeSummary || '',
      spinner: data.spinner || '⠋',
      phaseElapsed: data.phaseElapsed || '',
      compact: data.compact === true,
    }) + '\n');
    return;
  }
  if (opts.printResult) {
    let result;
    try {
      result = JSON.parse(opts.printResult);
    } catch (error) {
      process.stderr.write('ERROR: --print-result needs valid JSON: ' + error.message + '\n');
      process.exit(2);
    }
    const label = { done: 'Done', partial: 'Chưa hoàn tất', blocked: 'Blocked', cancelled: 'Đã hủy', timed_out: 'Hết thời gian' }[result.status] || 'Failed';
    const body = formatResultSummary(result);
    process.stdout.write(label + (result.turns != null ? ' · ' + result.turns + ' turn(s)' : '') + '\n'
      + (body ? body + '\n' : ''));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('ERROR: the TUI needs a TTY. Use agent.js for non-interactive runs.\n');
    process.exit(1);
  }

  const useAlt = !opts.noAlt;
  let restored = false;
  const restore = () => {
    if (!useAlt || restored) return;
    restored = true;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  };
  if (useAlt) process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.on('exit', restore);
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  process.on('SIGINT', () => { restore(); process.exit(130); });

  try {
    const app = render(React.createElement(App, { opts }), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await app.waitUntilExit();
  } catch (error) {
    restore();
    process.stderr.write('\nTUI failed: ' + error.message + '\n');
    process.exit(1);
  } finally {
    restore();
  }
}

main().catch((error) => {
  process.stderr.write('\nTUI failed: ' + (error && error.stack ? error.stack : error) + '\n');
  process.exit(1);
});
