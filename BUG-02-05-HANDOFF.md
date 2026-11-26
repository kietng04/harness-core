# BUG-02..BUG-05 handoff

Baseline: `8c11547` (BUG-01 fixed).

## BUG-02 — tab isolation

- `findCopilotPage` / `findMockPage` now claim a tab through `sessionStorage`
  (`harness.workspace`) and open a dedicated tab per canonical workspace.
- It never reuses the first Copilot tab owned by another workspace.
- `--launch` claims an unowned signed-in tab or opens a dedicated one.
- Resume checks `chatWorkspace`; mismatch returns `conversation_mismatch` before
  sending.
- `test/tab-isolation.js` starts one headless Edge, runs two workspaces against
  the same CDP endpoint, and asserts separate tabs + separate files.
- Test-only external mock mode: `HARNESS_MOCK_CDP`, `HARNESS_MOCK_URL`.

## BUG-03 — Node fallback matcher

- `makeMatcher()` now returns `re`, `caseSensitive`, `query`, `match`; regex
  no-match and case-sensitive literal no-match work in the Node fallback.
- Tests cover invalid regex, no-match regex, and `caseSensitive: true`.

## BUG-04 — grouped columns/deadline

- Grouped literal hits compute the column per query, not the first rg column.
- Expired batch deadline is checked before grouped dispatch; no scan starts and
  every pending leaf returns `status:"timeout"`.
- Tests: two literals on one line at different columns; expired deadline.

## BUG-05 — callee scope

- `functionBodyRange()` brace-matches the selected definition (strings/comments
  stripped) and scans only that body.
- Adjacent functions no longer leak callees. If braces cannot be found, coverage
  reports `unknown-one-line`/`truncated` and candidate confidence drops.
- Test: target + unrelated adjacent function, inline body, comment/string names.

## Verification

```text
SEND CONFIRMATION OK
TAB ISOLATION OK - two workspaces, one browser, separate owned tabs and files
POLICY/CONTEXT/GRAPH OK
CALL HIERARCHY OK - ... callees
REPO TOOLS OK
BATCH OK
A/B OK
E2E OK
MCP OK
REGRESSION OK
PTY OK - 46x12 and 120x40
```

## Remaining

Company Edge probe for BUG-01/02 selector/gesture behavior is still the only
live-environment verification. All fixes are local/mock reproducible.
