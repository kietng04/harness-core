#!/usr/bin/env node
'use strict';

/*
 * PR0/PR7/PR8 unit coverage: capability policy, audit, context ledger,
 * import graph, impact and test suggestions. Local only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../policy');
const ledger = require('../context-ledger');
const tools = require('../repo-tools');

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ctx-'));
try {
  // Policy
  check('read allowed readonly', policy.decide({ mode: 'readonly', tool: 'repo.read', workspace: root }).decision, 'allow');
  check('write denied readonly', policy.decide({ mode: 'readonly', tool: 'repo.apply_patch', workspace: root }).decision, 'deny');
  check('write denied preview', policy.decide({ mode: 'preview', tool: 'repo.apply_patch', workspace: root }).decision, 'deny');
  check('write approval ask', policy.decide({ mode: 'ask', tool: 'repo.apply_patch', workspace: root }).decision, 'approval_required');
  check('write allowed yolo', policy.decide({ mode: 'yolo', tool: 'repo.apply_patch', workspace: root }).decision, 'allow');
  const noBackend = policy.decide({ mode: 'yolo', tool: 'workspace.test', workspace: root });
  check('process unavailable', noBackend.code, 'policy_unavailable');
  const oldBackend = process.env.HARNESS_EXECUTION_BACKEND;
  process.env.HARNESS_EXECUTION_BACKEND = 'fixture';
  check('process with backend', policy.decide({ mode: 'yolo', tool: 'workspace.test', workspace: root }).decision, 'allow');
  if (oldBackend == null) delete process.env.HARNESS_EXECUTION_BACKEND;
  else process.env.HARNESS_EXECUTION_BACKEND = oldBackend;
  check('path escape denied', policy.decide({ mode: 'yolo', tool: 'repo.read', workspace: root, target: '../x' }).decision, 'deny');
  check('secret denied', policy.decide({ mode: 'yolo', tool: 'repo.read', workspace: root, target: '.env' }).decision, 'deny');
  policy.audit(root, { tool: 'repo.read', decision: 'allow', runId: 'r1' });
  check('audit written', fs.existsSync(path.join(root, '.harness', 'audit.jsonl')), true);

  // Context ledger
  const state = { context: ledger.create() };
  ledger.record(state, 'goal', 'goal', 'fix auth', 0);
  ledger.record(state, 'goal', 'goal', 'fix auth', 1);
  check('ledger duplicate bytes', ledger.summary(state).duplicateBytes > 0, true);
  ledger.record(state, 'src/a.js:1-20', 'source', 'const a = 1', 1);
  const changed = ledger.invalidate(state, ['src/a.js']);
  check('ledger invalidated', changed, 1);
  const epoch = ledger.newEpoch(state);
  check('ledger epoch', epoch, 1);
  check('ledger stale count', ledger.summary(state).staleItems >= 1, true);

  // Import graph, impact, tests.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'repository.js'), 'module.exports = { load: () => 1 };\n');
  fs.writeFileSync(path.join(root, 'src', 'service.js'), "const repo = require('./repository');\nmodule.exports = { run: repo.load };\n");
  fs.writeFileSync(path.join(root, 'src', 'controller.js'), "const service = require('./service');\nmodule.exports = { go: service.run };\n");
  fs.writeFileSync(path.join(root, 'test', 'service.test.js'), '// service test\n');
  const graph = tools.runTool(root, 'repo.graph', {});
  check('graph ok', graph.ok, true);
  check('graph edge service->repository', graph.data.edges.some((e) => e.from === 'src/service.js' && e.to === 'src/repository.js'), true);
  check('graph edge controller->service', graph.data.edges.some((e) => e.from === 'src/controller.js' && e.to === 'src/service.js'), true);
  const impact = tools.runTool(root, 'repo.impact', { path: 'src/repository.js' });
  check('impact affected service', impact.data.affected.includes('src/service.js'), true);
  check('impact affected controller', impact.data.affected.includes('src/controller.js'), true);
  const tests = tools.runTool(root, 'repo.tests', { path: 'src/service.js' });
  check('test suggestion', tests.data.suggestions.some((s) => s.path === 'test/service.test.js'), true);
  const diagnostics = tools.runTool(root, 'workspace.diagnostics', {});
  check('diagnostics unavailable', diagnostics.code, 'policy_unavailable');

  if (failures) {
    console.error('\nPOLICY/CONTEXT/GRAPH FAILED: ' + failures + ' assertion(s)');
    process.exitCode = 1;
  } else {
    console.log('POLICY/CONTEXT/GRAPH OK - capabilities, audit, ledger invalidation, graph, impact, tests');
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
