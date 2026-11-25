#!/usr/bin/env node
'use strict';

/*
 * Deterministic agent stand-in for PTY layout tests. It emits the same
 * structured event stream as agent.js, paints a long scrolled transcript, and
 * parks with an approval request open until the TUI answers on stdin.
 */

const readline = require('readline');

const runId = 'run-pty-fixture';
let seq = 0;
const emit = (type, payload = {}) => {
  seq++;
  process.stdout.write('__HARNESS_EVENT__' + JSON.stringify({
    v: 1,
    runId,
    seq,
    at: new Date().toISOString(),
    type,
    payload,
  }) + '\n');
};
const write = (line) => process.stdout.write(line + '\n');

emit('run.info', { runId, mode: 'ask', workspace: process.cwd(), provider: 'fixture' });
emit('run.started', {
  goal: 'layout fixture',
  mode: 'ask',
  turn: 0,
  maxTurns: 5,
  workspace: process.cwd(),
  progress: { direction: 'Inspect checkpoint path', milestone: 'Inspect checkpoint', phase: 'preparing' },
});
emit('progress.phase', { phase: 'preparing', turn: 0, direction: 'Inspect checkpoint path' });
emit('progress.intent', {
  intent: 'Inspect checkpoint path',
  milestone: 'Inspect checkpoint',
  milestoneId: 'm1',
  changeReason: '',
  turn: 0,
});
emit('progress.phase', { phase: 'waiting', turn: 0, milestone: 'Inspect checkpoint' });

setTimeout(() => {
  emit('progress.phase', { phase: 'verifying', turn: 0, checks: ['resume-test'] });
  emit('progress.verification', {
    status: 'failed',
    revision: 'rev-fixture-1',
    total: 2,
    passed: 1,
    missing: ['resume-test'],
    checks: [{ id: 'resume-test', status: 'failed', exitCode: 1 }],
  });

  for (let i = 1; i <= 30; i++) {
    write('__HARNESS_SCRIPT__' + JSON.stringify({
      turn: i,
      script: '# note: inspect workspace step ' + i + '\npwd',
    }));
    for (let line = 1; line <= 3; line++) {
      write('  . step ' + i + ' output line ' + line + ' — a scrolling transcript row');
    }
    write('exit=0 in 4ms (3 lines)');
    write('timing: send 0.1s | copilot 0.2s | exec 0.0s | prompt 0.1k chars');
  }

  emit('progress.phase', { phase: 'approval', turn: 30, kind: 'bash', actionId: 9 });
  emit('approval.requested', {
    actionId: 9,
    kind: 'bash',
    script: '# note: run the final verification\nnpm test -- --filter resume',
  });
  write('CẦN DUYỆT · Chạy bash');
  write('  ┌ npm test -- --filter resume');
  write('  [a] duyệt lần này · [x] từ chối');
}, 450);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let approved = false;
  try { approved = JSON.parse(line).approve === true; } catch {}
  emit('approval.granted', { actionId: 9, kind: 'bash' });
  write('DENIED BY USER: fixture action not executed.');
  write('WARN: layout fixture done');
  const result = {
    status: 'partial',
    reason: 'verification_failed',
    turns: 30,
    canResume: true,
    summary: approved ? 'fixture approved' : 'fixture denied · approval panel closed',
    verification: {
      status: 'failed',
      checks: [{ id: 'resume-test', status: 'failed', exitCode: 1, artifactRef: 'verify/resume-test-001.txt' }],
    },
    review: { status: 'skipped', findings: [] },
  };
  emit('run.finished', {
    status: result.status,
    turns: result.turns,
    reason: result.reason,
    canResume: true,
    verification: result.verification,
    review: result.review,
  });
  write('');
  write('__HARNESS_RESULT__' + JSON.stringify(result));
  setTimeout(() => process.exit(0), 50);
});
