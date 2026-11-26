'use strict';

/*
 * Capability policy. Decisions are made in code, never from prompt text.
 * Modes: yolo (legacy), ask, preview, readonly, isolated.
 */

const fs = require('fs');
const path = require('path');

const os = require('os');
const ignore = require('./ignore');

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
  'repo.locate': 'read',
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

function resolveGlobalCursorDir() {
  if (process.env.CURSOR_CONFIG_DIR) return path.resolve(process.env.CURSOR_CONFIG_DIR);
  if (process.env.HARNESS_NO_GLOBAL_CONFIG === '1' || process.env.HARNESS_MOCK_REPLIES) return '';
  return path.join(os.homedir(), '.cursor');
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRuleToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^(Shell|Read|Write)\((.+)\)$/i.exec(s);
  if (!m) return { raw: s, kind: 'shell', spec: s };
  return { raw: s, kind: m[1].toLowerCase(), spec: m[2].trim() };
}

/**
 * Load granular allow/deny permission rules from project and user Cursor
 * config files (.cursor/cli.json, .cursor/permissions.json).
 */
function loadPermissions(workspace) {
  const canon = canonical(workspace || process.cwd());
  const candidates = [];
  const globalDir = resolveGlobalCursorDir();
  if (globalDir) {
    candidates.push(path.join(globalDir, 'permissions.json'));
    candidates.push(path.join(globalDir, 'cli.json'));
  }
  const gitRoot = ignore.findGitRoot(canon);
  if (gitRoot && gitRoot !== canon) {
    candidates.push(path.join(gitRoot, '.cursor', 'permissions.json'));
    candidates.push(path.join(gitRoot, '.cursor', 'cli.json'));
  }
  candidates.push(path.join(canon, '.cursor', 'permissions.json'));
  candidates.push(path.join(canon, '.cursor', 'cli.json'));

  const allow = [];
  const deny = [];
  for (const file of candidates) {
    const data = readJsonSafe(file);
    if (!data) continue;
    const perms = (data.permissions && typeof data.permissions === 'object') ? data.permissions : data;
    for (const r of (Array.isArray(perms.allow) ? perms.allow : [])) {
      const tok = normalizeRuleToken(r);
      if (tok) allow.push(tok);
    }
    for (const r of (Array.isArray(data.terminalAllowlist) ? data.terminalAllowlist : [])) {
      const tok = normalizeRuleToken(String(r).includes('(') ? r : `Shell(${r})`);
      if (tok) allow.push(tok);
    }
    for (const r of (Array.isArray(perms.deny) ? perms.deny : [])) {
      const tok = normalizeRuleToken(r);
      if (tok) deny.push(tok);
    }
  }
  return { allow, deny };
}

/**
 * Split a shell script into executable command segments (ignoring comments and
 * leading VAR=VAL env assignments) for granular Shell(...) permission matching.
 */
function splitShellCommands(script) {
  const text = String(script || '');
  const segments = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let esc = false;

  const pushSegment = () => {
    const trimmed = cur.trim();
    cur = '';
    if (!trimmed) return;
    const tokens = [];
    let tok = '';
    let qSingle = false;
    let qDouble = false;
    let qEsc = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (qEsc) { tok += ch; qEsc = false; continue; }
      if (ch === '\\' && !qSingle) { qEsc = true; continue; }
      if (ch === "'" && !qDouble) { qSingle = !qSingle; continue; }
      if (ch === '"' && !qSingle) { qDouble = !qDouble; continue; }
      if (!qSingle && !qDouble && /\s/.test(ch)) {
        if (tok) { tokens.push(tok); tok = ''; }
        continue;
      }
      tok += ch;
    }
    if (tok) tokens.push(tok);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    if (tokens.length) segments.push({ raw: trimmed, tokens, line: tokens.join(' ') });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\' && !inSingle) { cur += ch; esc = true; continue; }
    if (ch === "'" && !inDouble) { cur += ch; inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { cur += ch; inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble) {
      if (ch === '#') {
        while (i < text.length && text[i] !== '\n') i++;
        pushSegment();
        continue;
      }
      if (ch === '\n' || ch === ';' || ch === '|') {
        if (ch === '|' && text[i + 1] === '|') i++;
        pushSegment();
        continue;
      }
      if (ch === '&' && text[i + 1] === '&') {
        i++;
        pushSegment();
        continue;
      }
    }
    cur += ch;
  }
  pushSegment();
  return segments;
}

function matchShellSpec(spec, segment) {
  const normSpec = String(spec || '').trim().replace(/:/g, ' ').replace(/\s+/g, ' ');
  if (!normSpec) return false;
  if (normSpec.includes('*') || normSpec.includes('?')) {
    const re = new RegExp('^' + normSpec
      .split(/(\*\*|\*|\?)/)
      .map((part) => {
        if (part === '**') return '.*';
        if (part === '*') return '.*';
        if (part === '?') return '.';
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('') + '$');
    return re.test(segment.line);
  }
  const specWords = normSpec.split(' ');
  if (segment.tokens.length < specWords.length) return false;
  for (let i = 0; i < specWords.length; i++) {
    if (segment.tokens[i] !== specWords[i]) return false;
  }
  return true;
}

function matchPermissionRule(rule, kind, value) {
  if (!rule || rule.kind !== kind) return false;
  if (kind === 'shell') {
    return matchShellSpec(rule.spec, value);
  }
  return ignore.matchGlob(rule.spec, value, false);
}

function hasCommandSubstitution(script) {
  return /\$\(|`|<\(|>\(|\beval\b/.test(String(script || ''));
}

function decide(input = {}) {
  const mode = String(input.mode || 'yolo').toLowerCase();
  const tool = String(input.tool || '');
  const capability = input.capability || TOOL_CAPS[tool] || 'read';
  const workspace = canonical(input.workspace || process.cwd());
  const target = input.target ? String(input.target) : '';
  const perms = input.permissions || loadPermissions(workspace);

  if (!TOOL_CAPS[tool] && !input.capability) {
    return { decision: 'deny', reason: 'unknown tool: ' + tool, code: 'policy_denied' };
  }

  let targetRel = '';
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
    targetRel = ignore.toPosix(path.relative(workspace, real)).replace(/^\.\//, '') || ignore.toPosix(target).replace(/^\.\//, '');
    if (SECRET_RE.test(targetRel)) {
      return { decision: 'deny', reason: 'sensitive path: ' + target, code: 'policy_denied' };
    }
    const ignoreMatcher = ignore.createIgnoreMatcher(workspace);
    if (ignoreMatcher.isCursorIgnored(targetRel)) {
      return { decision: 'deny', reason: 'blocked by .cursorignore: ' + targetRel, code: 'policy_denied' };
    }
    if (capability === 'write' && ignore.isProtectedPath(targetRel, { planMode: mode === 'plan' })) {
      return { decision: 'deny', reason: 'protected governance/config path: ' + targetRel, code: 'policy_denied' };
    }
    const kind = capability === 'read' ? 'read' : 'write';
    const denyRule = perms.deny.find((r) => matchPermissionRule(r, kind, targetRel));
    if (denyRule) {
      return { decision: 'deny', reason: 'denied by permission rule: ' + denyRule.raw, code: 'policy_denied' };
    }
  }

  if (capability === 'process') {
    if (input.script) {
      const segments = splitShellCommands(input.script);
      for (const seg of segments) {
        const denyRule = perms.deny.find((r) => matchPermissionRule(r, 'shell', seg));
        if (denyRule) {
          return { decision: 'deny', reason: 'denied by permission rule: ' + denyRule.raw, code: 'policy_denied' };
        }
      }
      if (mode === 'ask' && segments.length && !hasCommandSubstitution(input.script)) {
        const allAllowed = segments.every((seg) => perms.allow.some((r) => matchPermissionRule(r, 'shell', seg)));
        if (allAllowed) {
          return { decision: 'allow', reason: 'allowed by shell permission rule', code: 'ok' };
        }
      }
    }
    if (mode === 'preview' || mode === 'readonly' || mode === 'plan') {
      return { decision: 'deny', reason: 'process capability is disabled in ' + mode, code: 'policy_denied' };
    }
    if (!input.skipBackendCheck && !process.env.HARNESS_EXECUTION_BACKEND) {
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

  if (capability === 'read') {
    return { decision: 'allow', reason: 'read capability', code: 'ok' };
  }

  if (capability === 'write') {
    if (mode === 'preview') return { decision: 'deny', reason: 'preview mode never writes', code: 'policy_denied' };
    if (mode === 'readonly') return { decision: 'deny', reason: 'read-only mode', code: 'policy_denied' };
    if (mode === 'plan') {
      if (targetRel && ignore.isPlanWritablePath(targetRel)) {
        return { decision: 'allow', reason: 'plan file write allowed in plan mode', code: 'ok' };
      }
      return {
        decision: 'deny',
        reason: 'plan mode forbids editing source files (only .harness/PLAN.md, .harness/NOTES.md, .cursor/plans/*.md)',
        code: 'policy_denied',
      };
    }
    if (mode === 'ask') {
      if (targetRel && perms.allow.some((r) => matchPermissionRule(r, 'write', targetRel))) {
        return { decision: 'allow', reason: 'write allowed by permission rule', code: 'ok' };
      }
      return { decision: 'approval_required', reason: 'write needs approval', code: 'ok' };
    }
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

module.exports = {
  TOOL_CAPS,
  decide,
  audit,
  loadPermissions,
  matchPermissionRule,
  splitShellCommands,
};
