# PR 2 + PR 3 handoff — progress events and independent reviewer

Repo: `/Users/kietnguyen/copilot-harness/`  
Plan: `/Users/kietnguyen/Documents/Codex/2026-11-25/swift-users-kietnguyen-copilot-harness/outputs/plan.md`

PR 1 is documented in `PR1-HANDOFF.md`. This file covers sections 7–8.

## PR 2 — progress events

### Engine

- `progress.intent`: emitted from the same fenced reply, after parsing and before
  approval/execution. Reads `# note:` and optional `# progress:` JSON from the
  first lines. Malformed metadata is ignored. Milestones get a stable local ID
  (`m1`, `m2`, ...) and are saved in the checkpoint.
- `progress.phase`: `preparing`, `waiting`, `approval`, `running`, `verifying`,
  `compacting`, `reviewing`, `stopping`. Payload includes run sequence, turn,
  milestone, action ID and phase-specific data.
- `progress.verification`: emitted by the verifier with `status`, `revision`,
  `passed`, `total`, `missing[]` and per-check IDs/artifact refs.
- On resume, `preparing` carries the saved direction/milestone and the last
  verification payload is replayed so the TUI restores the current check count.
- `--events` remains NDJSON and backward compatible; progress adds three event
  types rather than replacing existing events.

### TUI

- Three separate fields: model direction, engine phase, verified evidence.
- Status line order: phase label, direction/milestone, elapsed phase time, then
  details. Verification shows `x/y check đạt · còn <id>`.
- Transcript lines only for a new milestone, a change reason, an important
  verification pass/fail, or reviewer findings. Duplicates are keyed by
  run/milestone/reason/revision.
- Events from an old `runId` or non-monotonic `seq`, and events after
  `run.finished`, are ignored.
- `--print-progress <json>` renders the same status-line function for tests.
- New tests assert `progress.intent → action.started → progress.verification`
  order, monotonic seq, verifying/waiting status lines, review findings rendering,
  and that a light read task still uses exactly two provider sends.

## PR 3 — independent reviewer

### Flags / config

```bash
node agent.js --review "goal"            # optional reviewer
node agent.js --review-required "goal"   # required for done
HARNESS_REVIEW=1|required
REVIEW_MAX=3                             # cap per invocation
```

TUI: `/review` cycles off → optional → required; `--review`/`--review-required`
are forwarded. MCP: `review:true` / `reviewRequired:true` booleans.

### Flow

1. Runs only after verifier passes (`passed` or `unconfigured`) and PLAN/review
   gates pass. Verifier failure goes back to the main agent, never to the reviewer.
2. Opens a separate chat on real Edge and confirms the composer. Mock keeps the
   scripted page so fixtures can drive reviewer replies.
3. Reviewer gets goal, revision, check refs, and a bounded diff (Git diff, else
   declared input contents). It is read-only and its reply never enters the bash
   action parser.
4. Reply schema:

   ```json
   {"verdict":"ok","revision":"<revision>","evidenceRef":"...","findings":[]}
   ```

   `status` becomes `reviewed`, `invalid`, `timed_out` or `unavailable`.
   Revision must match; one review per revision.
5. Findings are sent to the main agent with `affectedCriteria` and `evidence`.
   After the fix, verification runs again on the new revision, then the reviewer
   runs again for that revision. `REVIEW_MAX` caps a single invocation.
6. Required review + missing/invalid/findings-with-no-budget → `partial` with
   `review_*` reason. Optional review keeps the verifier result and reports the
   review status in result/TUI/MCP.
7. Result JSON and `run.finished` both include the `review` object; artifacts live
   under `runs/<runId>/review/`.

### Tests

`test/regression.js` now covers:

- Reviewer skipped when not configured, and skipped when verification fails.
- Findings → main fix → new verifier revision → reviewer `ok` → `done`; two review
  artifacts and two `progress.phase: reviewing` events.
- Invalid schema required → `partial` reason `review_invalid`.
- Revision mismatch optional → `done` with `review.status=invalid` but verifier pass.
- `REVIEW_MAX=1` second revision → `partial` reason `review_unavailable`.
- Progress event order, seq monotonicity, change reason/milestone, TUI status lines.
- Review findings shown by TUI `--print-result`.

Full suite observed:

```text
SELFTEST OK
E2E OK (10.9s) - mock Copilot -> bash -> ATTACH -> DONE
MCP OK (10.8s + 6.0s) - initialize, tools/list, status, mock run, partial result
review flow: exit=0 status=done turns=2 actions=2 verification=passed review=reviewed:ok#2
checker schema invalid required: exit=3 status=partial reason=review_invalid review=invalid#1
checker schema invalid optional: exit=0 status=done verification=passed review=invalid:ok#1
review budget: exit=3 status=partial reason=review_unavailable review=unavailable#2
light task: exit=0 status=done verification=unconfigured
REGRESSION OK - verifier, resume, budget, action checkpoint, MCP/TUI parity
```

## Remaining limits

- Real-Edge review uses the same Edge page but a fresh chat; it re-seeds the main
  agent from on-disk memory after findings. There is no second parallel browser
  context.
- Reviewer output is evidence, not authority: only verifier pass plus policy can
  close the goal.
- The 46×12 PTY matrix is not automated; status-line content and truncation are
  covered by the shared rendering function, but not by a PTY snapshot test.
- A/B quality measurement for reviewer opt-in is not automated (plan section 8.2
  last bullet).
