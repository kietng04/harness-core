# BUG-01 handoff — submit confirmation

Baseline: `2f2d90b`.

## Fix

- `sendPrompt()` now has two phases: fill/submit, then confirmation.
- Send path prefers a visible + enabled button within the send selector set;
  fallback focuses the composer and sends Enter there (not global focus).
- Confirmation accepts:
  - a new user turn whose text matches the draft, or
  - a new generation signal on the same page.
  - Empty composer / successful click alone is not enough.
- One retry is allowed only when the draft is still present.
- If still unconfirmed: throw `send_unconfirmed`, keep `state.pendingDraft` and
  `state.lastSubmit`, do not start `waitForReply`, do not emit
  `provider.waiting`, do not send `FORMAT ERROR`, and do not mark done.
- `provider.waiting` is emitted only after `sendPrompt()` confirms.
- Reviewer emits its waiting event after confirmation too.
- Diagnostics log method (`button` / `composer-enter`), confirmation type,
  user-turn count and duration; draft text is not logged.

## Fixture

`test/send-confirmation.js` uses `mock/copilot.html` flags:

- `HARNESS_MOCK_HIDE_SEND=1`
- `HARNESS_MOCK_IGNORE_ENTER=first|all`
- `HARNESS_MOCK_HIDE_STOP=1`
- `HARNESS_MOCK_SEND_DELAY_MS=<ms>`

Cases:

1. Send hidden + first Enter ignored → one retry, user-turn confirmation,
   file created, `done`, 2 provider sends, 1 turn.
2. Send hidden + all Enters ignored → `partial`, reason `send_unconfirmed`,
   exit 3, turns 0, no `provider.waiting`, no `FORMAT ERROR:`, no done, draft
   and `lastSubmit.unconfirmed` in checkpoint.
3. Normal visible Send button → button submit + user-turn confirmation.
4. No Stop button + delayed user turn → confirmation waits and still creates
   exactly one user turn.

## Verification

```text
SELFTEST OK
SEND CONFIRMATION OK - retry once, unconfirmed keeps draft/no waiting/no nudge, normal path
POLICY/CONTEXT/GRAPH OK
CALL HIERARCHY OK
REPO TOOLS OK
BATCH OK
A/B OK
E2E OK
MCP OK
REGRESSION OK
PTY OK - 46x12 and 120x40
```

Observed logs:

```text
SUBMIT: no confirmation after 990ms (attempt 1/2, method=composer-enter, userTurns=0, draftStillPresent=true)
SUBMIT: retrying once because the original draft is still in the composer
SUBMIT: method=composer-enter confirmation=user-turn userTurns=1 in 105ms
```

Unconfirmed:

```text
SUBMIT: no confirmation after 530ms (attempt 2/2, method=composer-enter, userTurns=0, draftStillPresent=true)
result: partial, reason=send_unconfirmed, exitCode=3, turns=0
```

## Remaining verification

Company Edge selector/gesture behavior still needs a probe on the live company
build. The local fixture covers the state-machine bug. Do not share URLs, chat
content, or company data from probe logs.
