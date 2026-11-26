'use strict';

/**
 * Shared path canonicalization, glob matching, .gitignore/.cursorignore
 * evaluation, and Cursor-style governance/protected path guards.
 */

const fs = require('fs');
const path = require('path');

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function canonicalRoot(root) {
  const abs = path.resolve(root || '.');
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function findGitRoot(startDir) {
  let cur = canonicalRoot(startDir);
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function expandBraces(pattern) {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const parts = m[1].split(',');
  const out = [];
  for (const part of parts) {
    const next = pattern.slice(0, m.index) + part + pattern.slice(m.index + m[0].length);
    out.push(...expandBraces(next));
  }
  return out;
}

function globToRegexBody(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += '[' + cls + ']';
        i = end + 1;
        continue;
      }
    }
    if ('\\^$.|+(){}'.includes(ch)) out += '\\' + ch;
    else out += ch;
    i += 1;
  }
  return out;
}

/**
 * Compile a single gitignore / Cursor glob pattern into matchers.
 */
function compileGlob(rawPattern, opts = {}) {
  let line = String(rawPattern || '').trim();
  if (!line) return null;
  if (line.startsWith('#')) return null;
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);

  let negate = false;
  if (opts.allowNegation !== false && line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  line = toPosix(line).replace(/^\.\//, '');
  if (!line) return null;

  const dirOnly = line.endsWith('/');
  if (dirOnly) line = line.slice(0, -1);
  if (!line) return null;

  const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  if (!line) return null;

  const baseDir = toPosix(opts.baseDir || '').replace(/^\/+|\/+$/g, '');
  const regexes = [];
  for (const variant of expandBraces(line)) {
    const body = globToRegexBody(variant);
    const prefix = baseDir ? globToRegexBody(baseDir) + '/' : '';
    if (anchored) {
      regexes.push(new RegExp('^' + prefix + body + '$'));
    } else {
      regexes.push(new RegExp('^' + prefix + '(?:.+/)?' + body + '$'));
    }
  }
  return { raw: rawPattern, negate, dirOnly, anchored, baseDir, regexes };
}

function matchGlob(pattern, relPath, isDir = false) {
  const compiled = typeof pattern === 'string'
    ? compileGlob(pattern, { allowNegation: false })
    : pattern;
  if (!compiled) return false;
  const rel = toPosix(relPath).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel) return false;
  if (compiled.dirOnly) {
    if (isDir && compiled.regexes.some((re) => re.test(rel))) return true;
    const parts = rel.split('/');
    const max = isDir ? parts.length : parts.length - 1;
    for (let i = 1; i <= max; i++) {
      const dir = parts.slice(0, i).join('/');
      if (compiled.regexes.some((re) => re.test(dir))) return true;
    }
    return false;
  }
  return compiled.regexes.some((re) => re.test(rel));
}

function parseIgnoreFile(text, baseDir = '', source = 'cursorignore') {
  const rules = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const compiled = compileGlob(line, { baseDir, allowNegation: true });
    if (compiled) {
      compiled.source = source;
      rules.push(compiled);
    }
  }
  return rules;
}

function evaluateRules(rules, relPath, isDir = false) {
  const rel = toPosix(relPath).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel) return false;

  const parts = rel.split('/');
  const prefixes = [];
  for (let i = 1; i < parts.length; i++) {
    prefixes.push({ path: parts.slice(0, i).join('/'), isDir: true });
  }
  prefixes.push({ path: rel, isDir: !!isDir });

  let ignored = false;
  for (const rule of rules) {
    let matched = false;
    if (rule.negate) {
      // Un-ignore if file/dir itself or a parent is un-ignored?
      // Gitignore requires parent not to stay ignored, so check full target + dir prefixes.
      matched = rule.regexes.some((re) => re.test(rel));
      if (!matched && isDir) {
        matched = matchGlob(rule, rel, true);
      }
      if (matched) ignored = false;
      continue;
    }
    for (const step of prefixes) {
      if (rule.dirOnly && !step.isDir) continue;
      if (rule.regexes.some((re) => re.test(step.path))) {
        matched = true;
        break;
      }
    }
    if (matched) ignored = true;
  }
  return ignored;
}

function readSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > 256 * 1024) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Create a hierarchical .gitignore + .cursorignore matcher anchored at `root`.
 * `.cursorignore` is tracked separately as well because it blocks direct file reads
 * in addition to excluding search results.
 */
function createIgnoreMatcher(root, opts = {}) {
  const canonRoot = canonicalRoot(root);
  const gitRoot = findGitRoot(canonRoot) || canonRoot;
  const loadedDirs = new Set();
  const gitRules = [];
  const cursorRules = [];
  let negationSeen = false;

  function loadDir(dirAbs) {
    const key = path.resolve(dirAbs);
    if (loadedDirs.has(key)) return;
    loadedDirs.add(key);

    const relFromRoot = toPosix(path.relative(canonRoot, key));
    if (relFromRoot.startsWith('..')) {
      // Ancestor directory between gitRoot and canonRoot: only apply rules with root-anchored prefixes or global patterns relative to canonRoot.
      const gi = opts.includeGitignore !== false ? readSafe(path.join(key, '.gitignore')) : '';
      if (gi) {
        const parsed = parseIgnoreFile(gi, '', 'gitignore');
        if (parsed.some((r) => r.negate)) negationSeen = true;
        gitRules.push(...parsed);
      }
      const ci = opts.includeCursorignore !== false ? readSafe(path.join(key, '.cursorignore')) : '';
      if (ci) {
        const parsed = parseIgnoreFile(ci, '', 'cursorignore');
        if (parsed.some((r) => r.negate)) negationSeen = true;
        cursorRules.push(...parsed);
      }
      return;
    }

    const baseDir = relFromRoot === '.' ? '' : relFromRoot;
    if (opts.includeGitignore !== false) {
      const gi = readSafe(path.join(key, '.gitignore'));
      if (gi) {
        const parsed = parseIgnoreFile(gi, baseDir, 'gitignore');
        if (parsed.some((r) => r.negate)) negationSeen = true;
        gitRules.push(...parsed);
      }
    }
    if (opts.includeCursorignore !== false) {
      const ci = readSafe(path.join(key, '.cursorignore'));
      if (ci) {
        const parsed = parseIgnoreFile(ci, baseDir, 'cursorignore');
        if (parsed.some((r) => r.negate)) negationSeen = true;
        cursorRules.push(...parsed);
      }
    }
  }

  // Load chain from gitRoot down to canonRoot.
  const ancestors = [];
  let cur = canonRoot;
  while (true) {
    ancestors.push(cur);
    if (cur === gitRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  ancestors.reverse();
  for (const a of ancestors) loadDir(a);

  function ensureAncestorsFor(relPath) {
    const rel = toPosix(relPath).replace(/^\.\//, '');
    const parts = rel.split('/');
    let dir = canonRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = path.join(dir, parts[i]);
      loadDir(dir);
    }
  }

  return {
    root: canonRoot,
    loadDir,
    hasNegations: () => negationSeen,
    hasCursorIgnore: () => cursorRules.length > 0,
    isCursorIgnored(relPath, isDir = false) {
      ensureAncestorsFor(relPath);
      if (!cursorRules.length) return false;
      return evaluateRules(cursorRules, relPath, isDir);
    },
    isGitIgnored(relPath, isDir = false) {
      ensureAncestorsFor(relPath);
      if (!gitRules.length) return false;
      return evaluateRules(gitRules, relPath, isDir);
    },
    ignores(relPath, isDir = false) {
      ensureAncestorsFor(relPath);
      if (!gitRules.length && !cursorRules.length) return false;
      return evaluateRules([...gitRules, ...cursorRules], relPath, isDir);
    },
  };
}

// Paths that must never be modified or deleted by the agent via patch/write tools.
const PROTECTED_PATH_RE = new RegExp(
  '(^|/)(?:' +
    '\\.git(?:/|$)|' +
    '\\.harness(?:/|$)|' +
    'node_modules(?:/|$)|' +
    '\\.cursorignore$|' +
    '\\.cursorindexingignore$|' +
    '\\.cursor/[^/]*\\.json$|' +
    '\\.cursor/.+\\.json$|' +
    '\\.claude/[^/]*\\.json$|' +
    '\\.claude/.+\\.json$|' +
    '\\.vscode(?:/|$)|' +
    '[^/]*\\.code-workspace$' +
  ')',
  'i'
);

// Strictly immutable harness internals & control configs even in --plan mode.
const STRICT_IMMUTABLE_RE = new RegExp(
  '(^|/)(?:' +
    '\\.git(?:/|$)|' +
    'node_modules(?:/|$)|' +
    '\\.cursorignore$|' +
    '\\.cursorindexingignore$|' +
    '\\.cursor/[^/]*\\.json$|' +
    '\\.cursor/.+\\.json$|' +
    '\\.claude/[^/]*\\.json$|' +
    '\\.claude/.+\\.json$|' +
    '\\.vscode(?:/|$)|' +
    '[^/]*\\.code-workspace$|' +
    '\\.harness/(?:session\\.json(?:\\.tmp)?|lock|.*\\.lock|journal(?:/|$)|index(?:/|$)|journal\\.jsonl)$' +
  ')',
  'i'
);

// Paths permitted for planning output when running in --plan mode.
const PLAN_WRITABLE_RE = /^(?:\.harness\/(?:PLAN|NOTES)\.md|\.harness\/plans\/.*\.md|\.cursor\/plans\/.*\.md|PLAN\.md)$/i;

// Sensitive governance/instruction paths whose modification triggers a review warning.
const GOVERNANCE_PATH_RE = /(^|\/)(\.cursor(\/|$)|\.harness(\/|$)|\.claude(\/|$)|AGENTS(\.local)?\.md$|CLAUDE(\.local)?\.md$|BUGBOT\.md$|CODEOWNERS$|\.github\/copilot-instructions\.md$)/i;

function isPlanWritablePath(relPath) {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  if (!rel || STRICT_IMMUTABLE_RE.test(rel)) return false;
  return PLAN_WRITABLE_RE.test(rel);
}

function isProtectedPath(relPath, opts = {}) {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  if (!rel) return false;
  if (opts.planMode && isPlanWritablePath(rel)) return false;
  return PROTECTED_PATH_RE.test(rel);
}

function isGovernancePath(relPath) {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  return GOVERNANCE_PATH_RE.test(rel);
}

module.exports = {
  toPosix,
  canonicalRoot,
  isInside,
  findGitRoot,
  compileGlob,
  matchGlob,
  parseIgnoreFile,
  evaluateRules,
  createIgnoreMatcher,
  isProtectedPath,
  isPlanWritablePath,
  isGovernancePath,
};
