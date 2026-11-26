# Edge Copilot terminal harness (v4)

Cho Edge Copilot viết bash, máy bạn chạy lệnh, rồi gửi output ngược lại vào chat — lặp cho đến khi xong.

Yêu cầu: Node 18+ (đã test Node 25), Microsoft Edge, bash. Đã test trên macOS
(Edge 158, Apple Silicon).

```
Edge Copilot  ──1 fenced block──►  agent.js  ──bash──►  terminal (WORKDIR)
     ▲                                 │
     └──────── stdout/stderr + status ─┘
```

Không dùng API chính thức. Harness điều khiển Copilot web qua CDP (Playwright),
nên nó chạy với đúng profile Edge đã đăng nhập, không cần DOM API riêng.

## Nhanh

```bash
cd ~/copilot-harness
npm install                # chỉ cần playwright-core, không tải Chromium
node agent.js --login      # mở Edge + profile riêng, đăng nhập Copilot một lần
node agent.js "mục tiêu"   # yolo mặc định: chạy lệnh, deny list vẫn bật
```

Nếu muốn duyệt từng action:

```bash
node agent.js --ask "mục tiêu"       # duyệt từng bash/attach qua stdin
node agent.js --safe "mục tiêu"      # alias của --ask
node agent.js --preview "mục tiêu"   # chỉ đề xuất, không chạy
node agent.js --readonly "review ..." # review-only: không sửa source
```

## TUI giống Codex

Đây là TUI riêng (không phải binary Codex): giao diện giống Codex nhưng
**engine bên dưới là `agent.js`** — tức Edge Copilot viết bash, harness chạy
trong project và gửi output ngược lại.

```bash
cd /duong/dan/project-cua-fen
node /Users/kietnguyen/copilot-harness/tui.mjs
```

Hoặc:

```bash
cd /Users/kietnguyen/copilot-harness
npm run tui -- --cwd /duong/dan/project-cua-fen
```

Lần đầu nếu Edge chưa bật CDP:

- Trong TUI gõ `/login` (mở Edge + chờ đăng nhập), hoặc
- Chạy trước: `node ~/copilot-harness/agent.js --login`

Muốn xem demo không cần login/Edge: mở TUI rồi gõ `/mock`, sau đó nhập một goal
bất kỳ. Mock sẽ chạy `pwd`, tạo file, attach file và DONE bằng Edge headless.

**Phím**

| Phím | Việc |
|---|---|
| `Enter` | gửi goal / chạy lệnh slash |
| `PgUp` / `PgDn` | cuộn transcript |
| `Esc` | dừng agent đang chạy / xoá input |
| `Ctrl+O` | mở/ẩn full script + output của từng bước |
| `Ctrl+X` | thoát ngay (kể cả khi agent đang chạy) |
| `Ctrl+C` | lần 1: dừng agent hoặc xoá input; lần 2: thoát |
| `Ctrl+U` | xoá input |
| `Ctrl+L` | clear transcript |

TUI hiển thị theo kiểu step cards, mặc định thu gọn:

```text
>_ Copilot Harness   engine: agent.js · Edge Copilot → bash

› kiểm tra test còn lỗi không

• Ran npm test  +1  (4.2s)
  └ SELFTEST OK

✓ Done · 2 turn(s)  ·  18s
  Toàn bộ test pass.

ready  ·  ⏎ send  ·  /help  ·  ctrl+o details
╭──────────────────────────────────────────────────────────────╮
│ › Ask Copilot to do something…                               │
╰──────────────────────────────────────────────────────────────╯
~/project  ·  yolo  ·  ● edge      ^O details  ·  ^X quit
```

- Lệnh thành công chỉ hiện 1 dòng `• Ran ...`; lỗi tự bung 6 dòng cuối.
- `Ctrl+O` show full script, output và timing.
- Gõ `/` để xem gợi ý slash command.
- Nếu `.harness/PLAN.md` có checklist, thanh `Plan ▰▰▱▱ 2/4 · next: ...` hiện ngay trên composer.
- Technical log của harness (`PAGE`, `POLICY`, `connecting`, `timing`…) bị ẩn khỏi transcript mặc định.
- Copilot được dặn bắt đầu mỗi bash block bằng `# note: <việc sắp làm>`.
  TUI hiện dòng đó là `· ...` ngay trên step, nên giữa các lần chạy bash vẫn có commentary.
- **Auto-compact:** mặc định sau mỗi 10 turn, harness **hỏi chat Copilot hiện tại**
  viết handoff (`COMPACT` block: goal, việc đã xong, bước tiếp theo, file/
  lệnh quan trọng), lưu lại, **mở chat mới** rồi nhúng summary đó vào prompt
  đầu tiên dưới mục `HANDOFF FROM PREVIOUS CHAT`. Nếu Copilot không trả
  `COMPACT`, harness fallback về memory trên đĩa (PLAN/NOTES/session).
  TUI hiện:
  ```text
  ↻ Compacting context: asking Copilot for a handoff summary…
  ↻ New Copilot chat ready · handoff summary 1234 chars carried over.
  ```
  Đổi bằng `/auto-compact <n>` hoặc `--auto-compact <n>`. `/compact` làm tương
  tự ngay lập tức (hỏi handoff → mở chat mới → lưu summary vào session).

**Slash commands**

```text
/safe | /yolo     đổi chế độ duyệt (safe = ask, yolo = không hỏi)
/readonly         bật/tắt review mode (không sửa project)
/mock             bật/tắt mock Copilot
/max <n>          action budget mỗi invocation
/auto-compact <n> mở chat Copilot mới mỗi N turn
/compact          mở chat Copilot mới ngay
/cwd <path>       đổi project directory
/continue         resume .harness/session.json
/verify <file>    đặt verification manifest cho run sau
/status           Edge, mode, cwd, session, verify
/login            mở Edge + chờ đăng nhập Copilot
/probe            kiểm tra selector Copilot
/clear            clear transcript
/quit             thoát
```

TUI mặc định **yolo** (giống CLI). Footer hiển thị cwd, mode
(`yolo`/`ask`, `review`, `mock`) và trạng thái Edge. Deny list luôn bật;
`/safe` chỉ bật duyệt từng action.

Profile mặc định: `~/.copilot-harness/edge-profile` (tách khỏi Edge thường).
Lần đầu `--login` sẽ mở cửa sổ Edge; đăng nhập Copilot trong cửa sổ đó. Sau đó
harness dùng lại profile này. Không đóng cửa sổ Edge khi đang chạy harness.

URL mặc định là M365 Copilot (`https://copilot.cloud.microsoft/chat`). Nếu dùng
Copilot consumer, thêm `--chat-url https://copilot.com/`. Dùng tab Copilot bình
thường, **không dùng sidebar Copilot của Edge** (sidebar là WebView riêng, CDP
khó attach).

> Edge/Chrome mới không cho bật remote debugging trên profile mặc định. Vì vậy
> harness dùng profile riêng — đây là lý do phải login lại một lần.

## Cách hoạt động

Mỗi lượt, harness gửi một prompt tự chứa (goal + plan/notes + kết quả lần trước).
Copilot trả về **đúng một fenced block**:

| Dòng đầu block | Hành động |
|---|---|
| `bash` (hoặc `sh`, `zsh`, `console`) | Chạy script trong WORKDIR, gửi output lại |
| `DONE` + tóm tắt | Kết thúc |
| `BLOCKED` + lý do | Dừng, trả exit code 2 |
| `ATTACH` + JSON `{"file":"..."}` | Upload file trong WORKDIR vào chat rồi tiếp tục |
| `COMPACT` + handoff | Harness yêu cầu khi cần compact; lưu summary, mở chat mới (model không tự dùng) |

Ví dụ ATTACH:

````
```bash
ATTACH
{"file":"artifacts/screenshot.png"}
```
````

Lưu ý: protocol yêu cầu JSON ở dòng kế tiếp; harness chấp nhận cả block có
language label `bash` vì Copilot thường render như vậy. Prompt cũng dặn rõ:
luôn mở fence bằng ` ```bash ` — kể cả `DONE`/`BLOCKED`/`ATTACH` — và đặt
protocol word ở dòng đầu **bên trong** block, không đặt làm language tag.

Với bash block, dòng đầu nên là một comment ngắn:

```bash
# note: kiểm tra test suite trước khi sửa auth
npm test
```

Harness/TUI hiện `# note:` thành `· ...` trước step; nó chỉ là comment nên
không ảnh hưởng lệnh. DONE/BLOCKED/ATTACH dùng summary/reason làm commentary.

Mỗi lượt:
- timeout command (`SCRIPT_TIMEOUT_MS`, mặc định 5 phút) và cả lượt (`MAX_TURN_MS`)
- output được cắt head/tail, giữ lỗi ở cuối; log đầy đủ ở `~/.copilot-harness/runs/<turn>/output.txt`
- state lưu ở `WORKDIR/.harness/session.json`; memory ở `PLAN.md` / `NOTES.md`
- phát hiện script lặp, kết quả lặp, Copilot trả prose/không có block → nudge có giới hạn
- `--per-run`: chat mới mỗi lượt (prompt vẫn self-contained; ATTACH bị tắt)
- `--readonly`: review mode + read coverage + evidence gate
- `DONE` bị chặn khi PLAN còn ô chưa tick, review thiếu evidence, hoặc verifier fail

### `--verify`: kiểm bằng chứng trước khi chốt DONE

Manifest do người dùng cấp trước khi chạy. Engine validate sớm, chạy đúng
executable/argv đã khai báo bằng `spawn(..., {shell:false})`, và chỉ chốt `done`
khi mọi check pass.

```json
{
  "version": 1,
  "inputPaths": ["src/filter.js"],
  "checks": [
    {
      "id": "filter-empty",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/check-filter-empty.mjs"],
      "timeoutMs": 5000
    }
  ]
}
```

- `command` phải là đường dẫn tuyệt đối, executable; `args` là mảng.
- `inputPaths` là file trong workspace; `.harness` và đường dẫn thoát workspace bị từ chối.
- Fingerprint nội dung `inputPaths` + file checker được tính trước/sau mỗi lần verify.
  File đổi giữa chừng → `verification.status="stale"`, không dùng evidence cũ.
- Check có trạng thái `passed | failed | timed_out | unavailable`; output lưu ở
  `~/.copilot-harness/runs/<runId>/verify/<check>-<attempt>.txt`.
- Mode `preview` chạy verifier với **zero subprocess** → `verification.status="unavailable"`,
  result `partial`. Mode `ask` hỏi duyệt manifest một lần.
- Resume kiểm lại manifest từ path đã lưu + fingerprint. File đổi/mất →
  `verification_spec_changed` / `verification_unavailable`, không âm thầm dùng config mới.
- Goal không có manifest vẫn chạy bình thường; result ghi
  `verification.status="unconfigured"` và vẫn áp gate PLAN/review.

### Result và resume

- Task một bước dùng prompt ngắn (~1 KB); tự chuyển prompt đầy đủ khi có PLAN
  hoặc khi kết quả lặp lại.
- Result có `metrics`: `sends`, `promptBytes`, `execMs`, `toolMs`, `verifyMs`,
  `reviewMs` để đo chi phí từng phần.

Mỗi invocation có một terminal result:

| status | exit | canResume | Ý nghĩa |
|---|---:|---|---|
| `done` | 0 | false | Verifier pass (hoặc unconfigured) + gate pass |
| `partial` | 3 | true | Hết budget, verifier fail/stale/unavailable, gate còn mở |
| `blocked` | 2 | true | Copilot cần người quyết định; hoặc `resume_inspection_required` (false) |
| `timed_out` | 5 | true | Hết `MAX_TOTAL_MS` |
| `cancelled` | 4 | true | Ctrl+C |
| `error` | 1 | false | Lỗi engine/checkpoint (`checkpoint_write_failed`, `session_corrupt`...) |

`--max-turns` là budget **mỗi invocation**. `state.turn` vẫn cộng dồn để đặt tên
artifact/timing/auto-compact. Khi dùng hết action budget, engine cho đúng một lượt
kết thúc chỉ nhận `DONE` hoặc `BLOCKED`; bash/ATTACH ở lượt đó → `partial`.

Action được ghi `started` trước khi spawn/upload và `finished` sau khi có kết quả.
Nếu checkpoint chỉ có `started` (bị kill giữa chừng), `--continue` dừng với
`resume_inspection_required` và ID/turn để đối soát; không replay mù.

### Progress events (PR 2)

Engine phát thêm ba nhóm event NDJSON khi `--events` bật (TUI dùng trực tiếp):

| Event | Nội dung | TUI hiện |
|---|---|---|
| `progress.intent` | `intent`, `milestone`, `milestoneId`, `changeReason`, `turn` | Dòng định làm / lý do đổi hướng; note bash vẫn nằm trên step card |
| `progress.phase` | `phase` (`preparing`, `waiting`, `approval`, `running`, `verifying`, `compacting`, `reviewing`, `stopping`), `turn`, `actionId`, `milestone` | Label + thời gian phase hiện tại |
| `progress.verification` | `status`, `revision`, `passed`, `total`, `missing[]`, `checks[]` | `Đang xác minh · 1/2 check đạt · còn <id>` |

Copilot có thể gửi metadata trong 2 dòng comment đầu script:

```bash
# note: so output test với nhánh resume
# progress: {"milestone":"Tái hiện lỗi resume","changeReason":"checkpoint đã có nhưng bị từ chối"}
```

Metadata sai JSON/format bị bỏ qua. Engine lưu milestone/reason vào checkpoint;
resume dựng lại status line từ checkpoint rồi nhận event mới. TUI tách ba trường:
hướng dự kiến (model) → phase (engine) → evidence đã xác minh (verifier), và bỏ
event trùng `seq`/run cũ hoặc event sau terminal.

### Independent reviewer (PR 3, opt-in)

```bash
node agent.js --review "goal"            # reviewer bổ sung
node agent.js --review-required "goal"   # thiếu/sai review => partial
```

hoặc `HARNESS_REVIEW=1|required`. Reviewer chạy **sau khi verifier pass**, trong
một chat riêng (mock dùng cùng page để fixture điều khiển reply), chỉ trả JSON:

```json
{"verdict":"ok","revision":"<revision>","evidenceRef":"...","findings":[]}
```

- Chỉ nhận `verdict` `ok`/`findings`, `findings[]`, `evidenceRef`, `revision`.
- `revision` phải khớp revision vừa verify; sai → `invalid`, không tính pass.
- Không chạy command/ghi file/upload từ reply reviewer.
- Findings được gửi lại agent chính; sửa xong verifier chạy lại revision mới,
  rồi reviewer chạy lại cho revision đó.
- Tối đa 1 review/revision và `REVIEW_MAX` review/invocation (mặc định 3).
- Trạng thái: `skipped` (không opt-in), `reviewed`, `unavailable`, `timed_out`,
  `invalid`. Required + thiếu kết quả → `partial` lý do `review_*`; optional giữ
  kết quả verifier và hiện trạng thái review.

### Local code search (offline)

Harness có local code intelligence, **không phải semantic embedding**:

```bash
node agent.js --index
node agent.js --search "khôi phục phiên"
```

- Tokenizer tách `camelCase`, `snake_case`, `kebab-case`, Unicode.
- BM25 + exact path/symbol boost + synonym Việt–Anh.
- Index cache `.harness/index/repo-search-v1.json`, incremental theo mtime/size.
- Skip `.git`, `.harness`, `node_modules`, binary, file quá lớn, symlink escape.
- `repo.read` trả digest và range hiện tại trước khi sửa.

Copilot dùng typed tool qua fenced JSON:

```json
{"version":1,"tool":"repo.search","args":{"query":"resume session","strategy":"auto","limit":5}}
{"version":1,"tool":"repo.read","args":{"path":"src/a.js","from":1,"to":80}}
{"version":1,"tool":"repo.locate","args":{"symbol":"restoreCheckpoint","scope":["src"]}}
{"version":1,"tool":"tool.batch","args":{"actions":[
  {"id":"def","tool":"repo.search","args":{"query":"restoreCheckpoint","match":"literal","scope":["src"]}},
  {"id":"tests","tool":"repo.search","args":{"query":"stale_revision","match":"literal","scope":["test"]}}
]}}
```

Các tool: `repo.search`, `repo.read`, `repo.list`, `repo.map`, `repo.symbol`,
`repo.references`, `repo.graph`, `repo.impact`, `repo.tests`, `repo.diff`,
`repo.locate`, `repo.apply_patch`, `repo.rollback`, `tool.batch`,
`workspace.diagnostics`, `workspace.test`.

`repo.search` nhận `match:"literal"|"regex"` (dùng `rg` nếu có, fallback Node)
và `scope`, `limit`. `tool.batch` chạy tối đa 3 read action với concurrency 2,
giữ thứ tự input, mỗi action có `id`; literal cùng scope được gom một lần scan.
`repo.locate` trả definitions + caller/callee một hop: import alias, comment bị
bỏ qua, call động/không resolve được đánh dấu `unresolved` với coverage và
revision. Backend hiện là regex/import graph, không thêm compiler dependency;
khi có LSP/tsc local có thể thay lớp `call-hierarchy.js`.
Patch validate digest,
ghi journal `.harness/journal/`, atomic rename; readonly/preview bị chặn; rollback
chỉ chạy khi file hiện tại đúng after-digest.
TUI cũng có `/search <query>` và `/index`.

### Policy, context và graph

- `policy.js`: capability read/write/process/send, preview/readonly/ask/yolo,
  path scope, secret denial, audit `.harness/audit.jsonl`.
- Lock workspace dùng `open(..., 'wx')` exclusive create, không check-then-write.
- `context-ledger.js`: digest/epoch/duplicate bytes; patch/rollback làm stale
  read coverage và ledger entry của file đã sửa.
- `repo.graph`, `repo.impact`, `repo.tests`: import graph, affected files và
  test gần change (advisory). `workspace.diagnostics`/`workspace.test` fail-closed
  nếu chưa có `HARNESS_EXECUTION_BACKEND`.
- Metrics result có `sends`, `promptBytes`, `execMs`, `toolMs`, `verifyMs`,
  `reviewMs`, `context`.

### Ảnh từ clipboard

Trong TUI bấm **Ctrl+V** để lấy ảnh PNG từ clipboard macOS, hoặc gõ:

```text
/paste
/image /duong/dan/anh.png
```

Ảnh được lưu vào `.harness/attachments/`, goal kế tiếp tự thêm dòng
`IMAGE TO ATTACH: ...` và agent upload bằng protocol `ATTACH` trước khi làm việc.
Terminal không nhận binary paste trực tiếp; `Ctrl+V`/`/paste` là đường dẫn ảnh.

### Skills trong `.cursor/skills`

Mỗi prompt (đầu, delta, resume, compact, retry, review) đều có đúng một khối
`AVAILABLE SKILLS` liệt kê `SKILL.md` trong `WORKDIR/.cursor/skills/**`. Tên lấy
từ frontmatter `name`, fallback thư mục; trùng tên thì kèm đường dẫn tương đối.
Symlink ra ngoài `.cursor/skills` bị bỏ qua. Thư mục rỗng ghi `(none)`.

Nếu goal nhắc đúng tên skill, nội dung `SKILL.md` được nạp vào prompt. Agent cũng
có thể yêu cầu skill bằng dòng đầu script `# skill: <name>`; engine nạp file và
tiếp tục, không cho model tự đọc đường dẫn tuỳ ý. Việc liệt kê tên không tạo thêm
lượt gọi Copilot.

## CLI

### Ngôn ngữ trả lời

Mặc định harness dặn Copilot trả `# note`, tóm tắt DONE/BLOCKED, progress và
review findings bằng **tiếng Việt**; command, code, path và JSON key giữ nguyên.
Đổi bằng:

```bash
node agent.js --lang en "goal"
HARNESS_LANG=en node agent.js "goal"
```

TUI cũng nhận `--lang`.

```bash
node agent.js --help

node agent.js "goal"                    # chạy (yolo mặc định, deny list vẫn bật)
node agent.js --ask "goal"              # duyệt từng action
node agent.js --preview "goal"          # chỉ đề xuất, không chạy
node agent.js --continue [session.json] # resume (mặc định .harness/session.json)
node agent.js --verify checks.json "goal" # verifier trước khi nhận DONE
node agent.js --review "goal"           # reviewer bổ sung sau verify
node agent.js --review-required "goal"  # reviewer bắt buộc cho done
node agent.js --no-review "goal"        # tắt reviewer đã lưu trong session
node agent.js --per-run "goal"          # fresh chat mỗi lượt
node agent.js --auto-compact 10 "goal"  # new chat mỗi 10 turn (memory kept)
node agent.js --new-chat               # mở Copilot chat mới rồi thoát
node agent.js --readonly "review ..."   # review-only
node agent.js --no-attach "goal"        # tắt ATTACH
node agent.js --max-turns 20 "goal"     # ngân sách action mỗi invocation
node agent.js --probe                   # kiểm tra selector trên page thật
node agent.js --prompt "goal"           # in prompt đầu, không mở browser
node agent.js --context                # repo instructions + plan + git
node agent.js --search "khôi phục phiên" # local BM25 search
node agent.js --index                  # build/update search index
node agent.js --selftest               # unit tests
node agent.js --mock                   # E2E bằng mock Copilot + headless Edge
node agent.js --json "goal"            # in __HARNESS_RESULT__{...} cho MCP
```

Biến môi trường hữu ích: `CDP_URL`, `CHAT_URL`, `EDGE_BIN`, `EDGE_PROFILE`,
`HARNESS_HOME`, `HARNESS_MODE`, `MAX_TURNS`, `MAX_TURN_MS`, `MAX_TOTAL_MS`,
`AUTO_COMPACT_TURNS`, `HARNESS_ISOLATED_BACKEND`.

## Codex / MCP

`mcp-server.js` là MCP stdio server, không dependency. Nó expose:

- `copilot_status` — Edge/CDP/profile/session paths; gọi trước khi run nếu chưa chắc
- `copilot_run` — chạy goal; mặc định **yolo** (chạy, deny list vẫn bật),
  `mode:"preview"` chỉ đề xuất, `mode:"readonly"` cho review, `cwd` chọn project,
  `maxTurns` là budget mỗi invocation, `review:true` / `reviewRequired:true` bật
  reviewer. MCP chỉ hiển thị result/verification/review; không nhận executable
  hay recipe từ request.

Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.copilot-edge]
command = "/opt/homebrew/bin/node"
args = ["/Users/kietnguyen/copilot-harness/mcp-server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 3600
```

Sau khi thêm, kiểm tra:

```bash
codex mcp list
codex mcp get copilot-edge
```

Skill `~/.codex/skills/edge-copilot/SKILL.md` dạy Codex khi nào dùng MCP này và
cách xử lý khi CDP chưa bật. Ví dụ trong Codex:

> Dùng `copilot_status` kiểm tra Edge. Nếu ổn, gọi `copilot_run` với
> `cwd=/path/to/project`, `mode:"readonly"`, goal "review ...".

MCP mặc định `mode:"yolo"` (chạy, deny list vẫn bật). `mode:"preview"` chỉ đề
xuất; `mode:"ask"` bị từ chối vì MCP headless không có kênh duyệt. Kết quả
`partial`/`blocked` giữ nguyên `reason`, `canResume`, verification và artifacts.

Chạy MCP trực tiếp để test:

```bash
npm run mcp
node test/mcp-smoke.js
```

## Test

```bash
npm test
```

Bốn tầng:

1. `--selftest`: parser (DONE/BLOCKED/ATTACH), policy, plan, output truncation,
   attachment path safety, argv, migration v4, checkpoint write errors,
   verification manifest validation/fingerprint.
2. `test/e2e-mock.js`: Edge headless thật + mock Copilot; chạy bash, upload file,
   nhận DONE, kiểm tra file/session.
3. `test/mcp-smoke.js`: MCP handshake → tools/list → status → `copilot_run`
   (mock) → kết quả `done`, rồi một run `maxTurns:1` → `partial` giữ reason,
   canResume, artifact.
4. `test/regression.js`: false DONE → verification fail → partial (không ghi
   done), fix + resume → done, resume cùng `--max-turns`, migration
   `done+partial`, interrupted action, checkpoint write fail trước action,
   finalize write fail, stale evidence, check timeout, preview zero-spawn,
   manifest đổi khi resume, progress event order, TUI status line, reviewer
   findings → fix → re-verify → ok, reviewer schema/revision sai, review budget,
   TUI partial render.

Kết quả trên máy này (macOS, Edge 158, Node 25):

```
SELFTEST OK
E2E OK (11.9s) - mock Copilot -> bash -> ATTACH -> DONE
MCP OK (10.8s + 5.8s) - initialize, tools/list, status, mock run, partial result
REGRESSION OK - verifier, resume, budget, action checkpoint, MCP/TUI parity
```

Live test sau khi đăng nhập (M365 Copilot):

```
$ node agent.js --max-turns 4 \
  "Connectivity check. Run pwd and echo live-harness-ok. Then reply DONE."
--- turn 1 ---
  . /private/tmp/copilot-live-test2
  . live-harness-ok
  . exit=0
=== GOAL COMPLETE ===
```

M365 Copilot render code block bằng `div[aria-label="Code editor"]` (không phải
`<pre>`), nút gửi là `button[aria-label="Send"]`, nút dừng là
`button[aria-label="Stop generating"]`. Harness đã có selector cho cả ba.
Review mode chỉ bật khi goal có `review`/`audit`/`--readonly`; chữ "summary"
trong một goal build không còn ép review.

TUI đã test end-to-end bằng PTY + `--mock`:

```
› mock demo

· checking the workspace before we touch anything
• Ran pwd  +1  (10ms)
  └ mock-ok

· writing a file and reading it back to verify output
• Ran echo 'hello from mock' > mock-output.txt  +1  (14ms)
  └ hello from mock
• Attached mock-output.txt (16 bytes)

✓ Done · 3 turn(s) · 13s
  Mock loop complete.
  attachment=mock-output.txt
  sends=4
```

## An toàn

- Mặc định CLI/TUI/MCP là **yolo**: chạy lệnh không hỏi duyệt, nhưng deny list
  luôn bật. Dùng `--ask`/`--safe` (CLI/TUI) hoặc `mode:"preview"` (MCP) nếu không muốn.
- Deny list chỉ là lớp bảo vệ thô, không phải sandbox. Chạy trong repo sạch,
  commit trước, và không để secret trong WORKDIR.
- ATTACH chỉ cho file thật trong WORKDIR, chặn file trông như secret
  (`.env`, `.ssh`, `*.pem`, `id_rsa`, ...), tối đa 10 MB.
- Output terminal là **dữ liệu không tin cậy**; harness ghi rõ đó là output,
  không phải instruction. Vẫn có rủi ro prompt injection từ log/file.
- Log đầy đủ trong `~/.copilot-harness/runs/` có thể chứa output nhạy cảm;
  dọn định kỳ. `--readonly` là ràng buộc ở prompt, không phải sandbox cứng.
- Copilot web có thể thay đổi DOM bất cứ lúc nào. `--probe` in ra selector
  nào còn match; sửa `SEL` ở đầu `agent.js` nếu UI đổi.
- Đây là UI automation, có thể vướng ToS/rate limit của Microsoft.

## Troubleshooting

**`Cannot connect to Edge CDP`**
```bash
node agent.js --login
```
Nếu vẫn lỗi, kiểm tra một Edge instance khác đang dùng cùng profile:
`~/.copilot-harness/edge-profile`. Đóng nó rồi thử lại.

**Kẹt ở trang login**
Đăng nhập trong cửa sổ Edge do harness mở. `--login` chờ tối đa 5 phút
(`LOGIN_WAIT_MS`). Nếu tài khoản Copilot dùng SSO công ty, có thể cần login
lại trong profile riêng này.

**Không tìm thấy composer / nút Send**
```bash
node agent.js --probe
```
Gửi output cho mình; selectors nằm ở `SEL` trong `agent.js`.

**Copilot không trả code block**
Harness nudge tối đa 3 lần rồi dừng. Chạy `--prompt` để xem prompt đầu; có thể
Copilot đang bật web search / Think Deeper — tắt các mode đó trong chat.

**Script chạy quá lâu**
`SCRIPT_TIMEOUT_MS=60000 node agent.js ...` hoặc chia nhỏ goal.

## Cấu trúc

```
copilot-harness/
  agent.js          # harness (single file, Playwright-core) — the engine
  tui.mjs           # TUI giống Codex, gọi agent.js bên dưới
  mcp-server.js     # MCP stdio server cho Codex
  mock/copilot.html # fake Copilot cho E2E
  test/             # e2e + mcp smoke
  README.md
```

Bản `agent.js` gốc (v2) vẫn nằm ở thư mục làm việc cũ; bản này là v3, thêm
ATTACH, --per-run/--readonly/--login/--launch/--mock/--json, `--trace-scripts`
cho TUI và MCP.
# harness-core
