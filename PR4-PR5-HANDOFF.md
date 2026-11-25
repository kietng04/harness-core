# PR4/PR5 handoff — typed repo tools and local search

This adds the local code search that plan sections 11/13/14 asked for. It is
lexical + BM25 + structure + Vietnamese/English expansion, **not embeddings**.

## Added

| File | Role |
|---|---|
| `repo-search.js` | tokenizer, chunking, BM25, exact path/symbol, synonym expansion, index cache |
| `repo-tools.js` | typed tool dispatch, map/symbol/references, batch, transactional patch |
| `test/repo-tools.js` | tokenizer/search/read/patch/batch and typed agent E2E |
| `agent.js` | typed JSON action parser + tool execution with action lifecycle |
| `tui.mjs` | `/search`, `/index` |
| `README.md` | usage |

## Tools

- `repo.search`: `{query, scope, strategy: auto|lexical|hybrid, limit}`.
- `repo.read`: `{path, from, to, expectedDigest}` → current text + digest.
- `repo.list`: bounded file list.
- `repo.map`: files, configs, entrypoints, top symbols.
- `repo.symbol` / `repo.references`: declaration/reference lookup.
- `repo.apply_patch`: `changes[]` with optional `expectedDigest`; validates all
  before writing, writes a journal under `.harness/journal/`, atomically renames,
  invalidates the search cache, rejects readonly/preview.
- `repo.rollback`: reads an applied/partial patch journal, requires current file
  digest to equal the journal's after-image, then atomically restores before-text.
- `tool.batch`: up to 3 read-only actions, bounded output.

## Search behavior

- Tokenizer: camelCase, snake_case, kebab-case, Unicode, Vietnamese folding.
- Vietnamese synonyms: `khôi phục phiên` → resume/restore/checkpoint/session.
- BM25 + exact path/symbol boost + phrase boost; overlapping hits deduped.
- Index cache `.harness/index/repo-search-v1.json`; incremental by mtime/size,
  content digest for returned chunks.
- Skips `.git`, `.harness`, `node_modules`, vendor/build, binary, >512 KB files,
  secrets, symlink escape.
- `repo.read` marks only the range actually returned as read coverage.

## Typed agent protocol

Copilot can reply with one fenced JSON object instead of bash:

```json
{"version":1,"tool":"repo.search","args":{"query":"resume session","strategy":"auto","limit":5}}
```

Unknown tools, malformed envelopes, preview/readonly write attempts are denied.
Each tool action uses the existing `started`/`finished` checkpoint/journal path.

## Evidence

```text
SELFTEST OK
search p50=0ms (warm, fixture)
REPO TOOLS OK - tokenizer, BM25/exact search, read digest, patch journal, batch, typed agent E2E
E2E OK
MCP OK
REGRESSION OK
PTY OK
```

## Still not done from the full plan

PR6 is partially covered by `repo.apply_patch` + `repo.rollback`; diff/change
journal recovery is smaller than the full design. PR7 (context ledger), PR8
(graph retrieval/diagnostics), full PR0 policy engine remain open.

## Added with this slice

- Light default prompt (~1 KB for a one-step goal) instead of the ~3.6 KB full
  prompt; escalates to full prompt when PLAN exists or repeated results are seen.
- `metrics` in result/run.finished/MCP: provider sends, prompt UTF-8 bytes,
  exec/tool/verify/review milliseconds.
- `test/ab-review.js`: same fixture with and without the reviewer, two samples
  per side, p50 sends/bytes/wall time. It proves the reviewer costs exactly one
  extra provider turn and reports the extra bytes/time.
