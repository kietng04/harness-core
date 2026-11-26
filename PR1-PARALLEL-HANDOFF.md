# Harness Core PR1 handoff — parallel search, batch, locate hierarchy

Baseline: `a7f4aac`. This change adds the first execution slice (parallel
independent reads) plus the call-hierarchy candidate layer for `repo.locate`.

## Changed

| File | Change |
|---|---|
| `repo-search.js` | `match: literal|regex`, rg argv backend, Node fallback, snippets/columns/match counts, one-scan literal group |
| `repo-tools.js` | `runToolAsync`, `runBatchAsync`, per-leaf status, skipped metadata, concurrency 2, deadline/cancel, `repo.diff`, `repo.locate` |
| `call-hierarchy.js` | one-hop JS/TS caller/callee candidates via import/alias graph; comments/strings ignored; unresolved computed calls |
| `agent.js` | typed batch uses async executor + AbortController on SIGINT; prompt example/guidance |
| `ignore.js` | shared ignore/protected-path matcher used by repo tools |
| `test/batch-search.js` | literal/regex, node fallback, grouping, order, cap 2, cancel, agent E2E |
| `test/call-hierarchy.js` | ambiguous symbols, path:line selection, aliased imports, comments, dynamic calls |
| `test/repo-tools.js` | multi-edit same file, literal `$&`, overlap rejection |

## Contract

- `tool.batch` max 3 actions, optional `id` (fallback positional), whitelist read
  tools, results always input order, per-leaf `status`:
  `ok|no_hits|truncated|timeout|cancelled|error`.
- Literal searches sharing scope/case/limit are grouped into one scan. Regex
  stays separate unless parity is guaranteed.
- Default concurrency 2. A leaf failure does not drop other results.
- `repo.search` missing `match` keeps the old BM25 `strategy` path.
- `repo.locate` accepts `symbol` or `path/line/column`, returns definitions,
  one-hop callers/callees, unresolved computed calls, file revision, coverage.
  Multiple definitions without a position return `ambiguous:true` and no callers.
- Backend is regex/import graph (`semantic:false`) because no tsc/LSP is installed.
  A future local LSP backend can replace `call-hierarchy.js` without changing
  the result shape.

## Verification

```text
BATCH OK - literal/regex, rg+node fallback, async batch cap 2, order, cancel, agent E2E
CALL HIERARCHY OK - ambiguity, path:line selection, aliases, comments, unresolved, callees
REPO TOOLS OK - ... multi-edit, journal, rollback ...
A/B OK - reviewer costs exactly one extra provider turn
E2E OK
MCP OK
REGRESSION OK
PTY OK
```

Agent E2E: one `tool.batch` with 3 searches produces one observation and
`DONE`, with exactly 2 provider sends. Light task remains 2 sends.

Local benchmark (fixture, 5 iterations): sequential ~54-69 ms, batch ~27-32 ms.
This is a local mock-scale number, not a live-provider claim.

## Limits / next

- No compiler/LSP dependency is added. Call hierarchy is candidate precision;
  dynamic/aliased calls remain unresolved unless the import graph resolves them.
- PR 2 persistent trigram index is not enabled; `rg` is the default exact backend,
  Node fallback is implemented and tested.
- PR 5 context delta and PR 6 review fingerprint are not part of this slice.
