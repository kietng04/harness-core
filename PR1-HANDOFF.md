# PR 1 handoff — verifier, resume, budget, action checkpoints

Repo: `/Users/kietnguyen/copilot-harness/`  
Plan: `/Users/kietnguyen/Documents/Codex/2026-11-25/swift-users-kietnguyen-copilot-harness/outputs/plan.md`

## Files changed

| File | Change |
|---|---|
| `agent.js` | Canonical terminal results, v4 migration, strict checkpoint load, resumable `partial`, per-invocation turn budget + final DONE/BLOCKED turn, `started`/`finished` action records, `checkpoint_write_failed`, `resume_inspection_required`, `--verify` manifest runner, skills prompt block. |
| `mcp-server.js` | Reads status before exit code, verifies state/exit consistency, keeps `reason`/`canResume`/`verification`/artifacts for `partial` and `blocked`, rejects headless `ask`. |
| `tui.mjs` | Forwards `--verify`, `/verify`, renders `Chưa hoàn tất` + missing checks + `/continue`, `--print-result` for non-TTY tests. |
| `test/regression.js` | New PR 1 regression suite. |
| `test/e2e-mock.js` | Asserts `verification.status="unconfigured"` on a normal goal. |
| `test/mcp-smoke.js` | Adds a `partial`/exit 3 run and checks reason/canResume/artifacts. |
| `mock/copilot.html` | Optional scripted replies for fixtures (`window.__mockReplies`). |
| `package.json` | `npm test` now runs the regression suite. |
| `README.md` | `--verify`, result/exit table, resume/action rules, skills. |

## Behaviour

### `--verify <file.json>`

- Validated before provider contact. Absolute `command`, argv array, unique IDs,
  100 ms–120 s timeout, max 20 checks.
- `inputPaths` must stay inside the workspace after resolve; `.harness` is rejected.
- Runs with `shell:false`, limited env, output cap, per-check artifact under
  `runs/<runId>/verify/`.
- Fingerprints declared inputs + checker files before/after. Changes → `stale`.
- `preview` = zero subprocess; `ask` = one manifest approval; otherwise the
  manifest is the only source of commands.
- Resume reloads the saved manifest path and compares `specHash` + canonical
  workspace. Missing/changed config fails before the provider:
  `verification_unavailable` / `verification_spec_changed`.
- No manifest → `verification.status="unconfigured"` and the existing PLAN/review
  gates still apply.

### DONE and resume

- `done:true`/`doneAt` are written only when the verifier passes (or is
  unconfigured) and all completion gates pass.
- A failed DONE keeps a `partial` checkpoint with `verification.checks`.
- v4 checkpoints with both `done:true` and `partial:true` migrate to resumable
  `partial`; a real `done` returns `already_done`; corrupt JSON returns
  `session_corrupt`.
- Finalize order is status → checkpoint → terminal result/event. A failed
  checkpoint write returns `checkpoint_write_failed` with `canResume:false` and
  is not advertised as a new resume point.

### Budget and actions

- `--max-turns` counts actions in the current invocation; `state.turn` stays
  cumulative.
- After the last action, one final provider turn accepts only `DONE`/`BLOCKED`.
  A bash/ATTACH reply there returns `partial` and keeps the last observation.
- `started` action records are persisted before spawn/upload; `finished` carries
  the outcome and artifact refs.
- A checkpoint with only `started` returns `blocked` +
  `resume_inspection_required` (action ID/turn/script), with zero replay.

## Tests

Run from the repo root:

```bash
npm test
```

Observed on this machine:

```text
SELFTEST OK
E2E OK (11.0s) - mock Copilot -> bash -> ATTACH -> DONE
MCP OK (10.9s + 5.9s) - initialize, tools/list, status, mock run, partial result
  false DONE: exit=3 status=partial reason=verification_failed turns=1 actions=1
  changed manifest: exit=1 status=error code=verification_spec_changed
  fix + resume: exit=0 status=done turns=1 actions=1
  same cap A: exit=3 status=partial reason=turn budget reached (1) turns=1 actions=1
  same cap B: exit=0 status=done turns=2 actions=2
  interrupted: exit=2 status=blocked reason=resume_inspection_required turns=2 actions=1
  write before action: exit=1 status=error code=checkpoint_write_failed
  write finalize: exit=1 status=error code=checkpoint_write_failed
  migrate done+partial: exit=0 status=done turns=3 history=1
  real done: exit=1 status=error code=already_done
  corrupt session: exit=1 status=error code=session_corrupt
  missing manifest: exit=1 status=error code=verification_unavailable
  stale evidence: exit=3 status=partial reason=verification_stale
  preview: exit=3 status=partial reason=verification_unavailable
REGRESSION OK - verifier, resume, budget, action checkpoint, MCP/TUI parity
```

The fixture flow reproduces the plan target: false DONE → verifier fail →
`partial` checkpoint → fix fixture → `/continue` → verifier pass → `done`, with
the original action executed once.

## Remaining limits (PR 1 scope)

- Sequential resume of one workspace only; exclusive workspace lock acquisition
  is still a separate PR.
- Manifest checkers are trusted user input. They run outside the model's action
  stream, but the MVP does not sandbox the checker process itself.
- MCP never accepts a manifest/executable from the request; it only reports the
  result. There is no MCP `/continue` tool yet.
- Progress events (PR 2) and the optional independent reviewer (PR 3) are not in
  this PR.
