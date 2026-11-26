'use strict';

/*
 * Capability policy. Decisions are made in code, never from prompt text.
 * Modes: yolo (legacy), ask, preview, readonly, isolated.
 */

const fs = require('fs');
const path = require('path');

const TOOL_CAPS = {
  'repo.search': 'read',
  'repo.read': 'read',
  'repo.list': 'read',
  'repo.map': 'read',
  'repo.symbol': 'read',
  'repo.references': 'read',
  'repo.graph': 'read',
  'repo.impact': 'read',
  'repo.tests': 'read',
  'repo.diff': 'read',
  'repo.apply_patch': 'write',
  'repo.rollback': 'write',
  'tool.batch': 'read',
  'workspace.diagnostics': 'process',
  'workspace.test': 'process',
  'skill.load': 'read',
};

const SECRET_RE = /(^|\/)(\.env|\.env\..*|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.log)$/i;

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function canonical(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

function decide(input = {}) {
  const mode = String(input.mode || 'yolo').toLowerCase();
  const tool = String(input.tool || '');
  const capability = input.capability || TOOL_CAPS[tool] || 'read';
  const workspace = canonical(input.workspace || process.cwd());
  const target = input.target ? String(input.target) : '';

  if (!TOOL_CAPS[tool] && !input.capability) {
    return { decision: 'deny', reason: 'unknown tool: ' + tool, code: 'policy_denied' };
  }

  if (capability === 'process') {
    if (mode === 'preview' || mode === 'readonly') {
      return { decision: 'deny', reason: 'process capability is disabled in ' + mode, code: 'policy_denied' };
    }
    if (!process.env.HARNESS_EXECUTION_BACKEND) {
      return {
        decision: 'deny',
        reason: 'no approved execution backend (set HARNESS_EXECUTION_BACKEND)',
        code: 'policy_unavailable',
      };
    }
    return {
      decision: mode === 'ask' ? 'approval_required' : 'allow',
      reason: 'process capability with approved backend',
      code: 'ok',
    };
  }

  if (target && (capability === 'read' || capability === 'write')) {
    const abs = path.resolve(workspace, target);
    if (!isInside(workspace, abs)) {
      return { decision: 'deny', reason: 'path outside workspace: ' + target, code: 'policy_denied' };
    }
    let real = abs;
    try { real = fs.realpathSync(abs); } catch {}
    if (!isInside(workspace, real)) {
      return { decision: 'deny', reason: 'symlink escapes workspace: ' + target, code: 'policy_denied' };
    }
    if (SECRET_RE.test(target.split(path.sep).join('/'))) {
      return { decision: 'deny', reason: 'sensitive path: ' + target, code: 'policy_denied' };
    }
  }

  if (capability === 'read') {
    return { decision: 'allow', reason: 'read capability', code: 'ok' };
  }

  if (capability === 'write') {
    if (mode === 'preview') return { decision: 'deny', reason: 'preview mode never writes', code: 'policy_denied' };
    if (mode === 'readonly') return { decision: 'deny', reason: 'read-only mode', code: 'policy_denied' };
    if (mode === 'ask') return { decision: 'approval_required', reason: 'write needs approval', code: 'ok' };
    return { decision: 'allow', reason: 'write capability', code: 'ok' };
  }

  if (capability === 'send') {
    if (mode === 'preview') return { decision: 'deny', reason: 'preview mode does not send actions', code: 'policy_denied' };
    return { decision: 'allow', reason: 'provider send allowed', code: 'ok' };
  }

  return { decision: 'deny', reason: 'unsupported capability: ' + capability, code: 'policy_denied' };
}

function audit(workspace, event = {}) {
  try {
    const dir = path.join(canonical(workspace), '.harness');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...event,
    });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), line + '\n');
  } catch {}
}

module.exports = { TOOL_CAPS, decide, audit };
