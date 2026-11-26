#!/usr/bin/env node
'use strict';

/*
 * PR 1: parallel literal/regex search and async tool.batch.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const search = require('../repo-search');
const tools = require('../repo-tools');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent.js');
let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-search-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'test'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'resume.js'), [
    'function restoreCheckpoint(session) { return session.id; }',
    'const marker = "a+b [x]";',
    'const twice = "a+b [x]"; // a+b [x] again',
    'module.exports = { restoreCheckpoint };',
  ].join('\n'));
  fs.writeFileSync(path.join(work, 'test', 'resume.test.js'), [
    '// restoreCheckpoint stale_revision',
    'const x = "a+b [x]";',
  ].join('\n'));

  try {
    const literal = tools.runTool(work, 'repo.search', {
      query: 'a+b [x]', match: 'literal', scope: ['src'], limit: 5,
    });
    check('literal ok', literal.ok, true);
    check('literal special hit', literal.data.hits.length >= 1, true);
    check('literal same-line count', literal.data.hits.some((h) => h.matchCount >= 2), true);
    const nodeLiteral = await search.searchPatternAsync(work, {
      query: 'a+b [x]', match: 'literal', scope: ['src'], limit: 5, backend: 'node',
    }, {});
    check('node fallback backend', nodeLiteral.data.backend, 'node');
    check('node fallback hit', nodeLiteral.data.hits.length >= 1, true);

    const regex = tools.runTool(work, 'repo.search', {
      query: 'restoreCheckpoint\\s*\\(', match: 'regex', scope: ['src'], limit: 5,
    });
    check('regex hit', regex.data.hits.length, 1);
    const invalid = tools.runTool(work, 'repo.search', {
      query: '([', match: 'regex', scope: ['src'], limit: 5,
    });
    check('invalid regex', invalid.code, 'invalid_args');

    const legacy = await tools.runBatchAsync(work, {
      actions: [
        { tool: 'repo.search', args: { query: 'restoreCheckpoint', limit: 2 } },
        { tool: 'repo.read', args: { path: 'src/resume.js', from: 1, to: 1 } },
      ],
    });
    check('legacy batch positional ids', legacy.data.results.map((r) => r.id).join(','), '1,2');
    check('legacy batch no match field', legacy.data.results[0].ok, true);

    const grouped = await tools.runBatchAsync(work, {      actions: [
        { id: 'definition', tool: 'repo.search', args: { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 3 } },
        { id: 'tests', tool: 'repo.search', args: { query: 'stale_revision', match: 'literal', scope: ['test'], limit: 3 } },
        { id: 'missing', tool: 'repo.search', args: { query: 'zzz-nope', match: 'literal', scope: ['src'], limit: 3 } },
      ],
    });
    check('batch result count', grouped.data.results.length, 3);
    check('batch ids order', grouped.data.results.map((r) => r.id).join(','), 'definition,tests,missing');
    check('batch definition', grouped.data.results[0].data.hits[0].path, 'src/resume.js');
    check('batch tests', grouped.data.results[1].data.hits[0].path, 'test/resume.test.js');
    check('batch no hit status', grouped.data.results[2].status, 'no_hits');

    const groupedSame = await tools.runBatchAsync(work, {
      actions: [
        { id: 'one', tool: 'repo.search', args: { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 2 } },
        { id: 'two', tool: 'repo.search', args: { query: 'marker', match: 'literal', scope: ['src'], limit: 2 } },
      ],
    });
    check('batch grouped scans', groupedSame.data.scans, 1);

    const mixed = await tools.runBatchAsync(work, {
      actions: [
        { id: 'ok', tool: 'repo.search', args: { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 2 } },
        { id: 'bad', tool: 'repo.search', args: { query: '([', match: 'regex', scope: ['src'], limit: 2 } },
        { id: 'read', tool: 'repo.read', args: { path: 'src/resume.js', from: 1, to: 2 } },
        { id: 'fourth', tool: 'repo.read', args: { path: 'src/resume.js', from: 1, to: 1 } },
      ],
    });
    check('batch skipped metadata', mixed.data.skipped, 1);
    check('batch bad independent', mixed.data.results[1].ok, false);
    check('batch good survives', mixed.data.results[0].ok, true);

    // Fake async executor: overlap, cap 2, input order, one failure isolated.
    {
      let active = 0;
      let peak = 0;
      const fake = async (workspace, name, args, opts) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, args.delay || 20));
        active--;
        if (opts.signal && opts.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
        if (args.fail) return { ok: false, code: 'tool_error', error: 'fake failure' };
        return { ok: true, data: { id: args.id } };
      };
      const batch = await tools.runBatchAsync(work, {
        actions: [
          { id: 'a', tool: 'repo.search', args: { id: 'a', delay: 40 } },
          { id: 'b', tool: 'repo.search', args: { id: 'b', delay: 5 } },
          { id: 'c', tool: 'repo.search', args: { id: 'c', delay: 15, fail: true } },
        ],
      }, { executor: fake });
      check('concurrency cap 2', peak, 2);
      check('concurrency result order', batch.data.results.map((r) => r.id).join(','), 'a,b,c');
      check('concurrency failure isolated', batch.data.results[2].ok, false);
      check('concurrency success survives', batch.data.results[0].ok, true);

      const ac = new AbortController();
      ac.abort();
      const cancelled = await tools.runBatchAsync(work, {
        actions: [
          { id: 'a', tool: 'repo.search', args: { id: 'a', delay: 5 } },
          { id: 'b', tool: 'repo.search', args: { id: 'b', delay: 5 } },
        ],
      }, { signal: ac.signal, executor: fake });
      check('cancelled all leaves', cancelled.data.results.every((r) => r.status === 'cancelled'), true);
    }

    // Agent E2E: one batch with three searches -> one observation -> DONE.
    const agentWork = path.join(root, 'agent-work');
    fs.mkdirSync(agentWork, { recursive: true });
    fs.mkdirSync(path.join(agentWork, 'src'), { recursive: true });
    fs.copyFileSync(path.join(work, 'src', 'resume.js'), path.join(agentWork, 'src', 'resume.js'));
    const replies = path.join(root, 'replies.json');
    fs.writeFileSync(replies, JSON.stringify([
      JSON.stringify({
        version: 1,
        tool: 'tool.batch',
        args: {
          actions: [
            { id: 'def', tool: 'repo.search', args: { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 2 } },
            { id: 'special', tool: 'repo.search', args: { query: 'a+b [x]', match: 'literal', scope: ['src'], limit: 2 } },
            { id: 'none', tool: 'repo.search', args: { query: 'zzz', match: 'literal', scope: ['src'], limit: 2 } },
          ],
        },
      }),
      'DONE\nbatch complete',
    ]));
    const run = spawnSync(process.execPath, [
      AGENT, '--mock', '--json', '--events', '--max-turns', '4', '--workdir', agentWork, '--', 'batch search',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        HARNESS_HOME: home,
        HARNESS_MOCK_REPLIES: replies,
        POLL_MS: '120',
        POST_GEN_GRACE_MS: '700',
        MAX_TURN_MS: '30000',
      },
    });
    const out = String(run.stdout || '') + '\n' + String(run.stderr || '');
    check('agent batch exit', run.status, 0);
    check('agent batch one tool action', (out.match(/tool: tool\.batch/g) || []).length, 1);
    const events = String(run.stdout || '').split('\n')
      .filter((line) => line.startsWith('__HARNESS_EVENT__'))
      .map((line) => { try { return JSON.parse(line.slice('__HARNESS_EVENT__'.length)); } catch { return null; } })
      .filter(Boolean);
    check('agent batch provider sends', events.filter((e) => e.type === 'provider.waiting').length, 2);
    const resultMatch = String(run.stdout || '').match(/^__HARNESS_RESULT__(\{.*\})$/m);
    const result = resultMatch ? JSON.parse(resultMatch[1]) : null;
    check('agent batch done', result && result.status, 'done');
    const artifacts = [];
    const collect = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name === 'tool-result.json') artifacts.push(fs.readFileSync(full, 'utf8'));
      }
    };
    collect(path.join(home, 'runs'));
    const observation = artifacts.join('\n');
    includes('agent batch observation ids', observation, '"id": "def"');
    includes('agent batch observation no-hit', observation, '"status": "no_hits"');

    // Coarse benchmark: sequential vs batch on the same fixture.
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      tools.runTool(work, 'repo.search', { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 2 });
      tools.runTool(work, 'repo.search', { query: 'stale_revision', match: 'literal', scope: ['test'], limit: 2 });
    }
    const seqMs = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 5; i++) {
      await tools.runBatchAsync(work, {
        actions: [
          { id: 'a', tool: 'repo.search', args: { query: 'restoreCheckpoint', match: 'literal', scope: ['src'], limit: 2 } },
          { id: 'b', tool: 'repo.search', args: { query: 'stale_revision', match: 'literal', scope: ['test'], limit: 2 } },
        ],
      });
    }
    const batchMs = Date.now() - t1;
    console.log('  batch bench: sequential=' + seqMs + 'ms batch=' + batchMs + 'ms (5 iterations)');

    if (failures) {
      console.error('\nBATCH FAILED: ' + failures + ' assertion(s)');
      process.exitCode = 1;
    } else {
      console.log('BATCH OK - literal/regex, rg+node fallback, async batch cap 2, order, cancel, agent E2E');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

function includes(name, haystack, needle) {
  check(name, String(haystack || '').includes(needle), true);
}

main().catch((e) => {
  console.error('BATCH ERROR: ' + e.stack);
  process.exitCode = 1;
});
