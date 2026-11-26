# Full-plan status

This repo now implements the executable local engine described by plan sections
0–19. Abstract design text (for example external telemetry/cloud evaluators) is
intentionally not implemented because the plan explicitly excludes it.

## Implemented

| Area | Status |
|---|---|
| PR0 policy/lock/checkpoint/audit | capability policy in `policy.js`, exclusive `open(..., 'wx')` lock, atomic checkpoint, audit `.harness/audit.jsonl` |
| PR1 verifier/resume/budget/action journal | implemented + regression |
| PR2 progress events/TUI/PTY | implemented + PTY tests |
| PR3 independent reviewer | implemented + A/B harness |
| PR4 typed tools | `repo.list/read/search/map/symbol/references/graph/impact/tests/apply_patch/rollback/batch` |
| PR5 local retrieval | camel/snake/kebab tokenizer, Vietnamese expansion, BM25, incremental cache, digest checks |
| PR6 editing | digest-validated patch, journal, atomic writes, rollback, user-edit conflict guard |
| PR7 context | local context ledger, duplicate bytes, epoch invalidation, stale tracking, compact epoch |
| PR8 graph | import graph, impact + test suggestions, diagnostics/test tools fail closed without execution backend |
| PR9 evaluation | offline regression, p50 search latency, reviewer A/B sends/bytes/wall time |

## Still deliberately bounded

- `workspace.diagnostics` and `workspace.test` return `policy_unavailable`
  unless an approved `HARNESS_EXECUTION_BACKEND` exists. This is the plan's
  fail-closed behavior.
- Graph edges are import edges only; dynamic calls are reported as unresolved.
- The context ledger records/invalidates context but the prompt is still
  rehydrated in full when needed; it does not implement token-level delta
  prompts.
- No cloud embeddings, hosted vector DB, external benchmark service, remote MCP,
  or live company-code evaluation.

## Verify

```bash
npm test
node agent.js --search "khôi phục phiên"
node agent.js --index
```
