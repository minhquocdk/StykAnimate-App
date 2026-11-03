# Handoff — MCP integration for StykAnimate

> Ngày: 2026-11-03 · Nhánh: `feat/mcp-server` · Fork: https://github.com/minhquocdk/StykAnimate-App
> Mục tiêu: để AI (opencode/Claude) tạo và chỉnh sửa animation trong StykAnimate qua MCP.

## 1. Trạng thái hiện tại

- **Phase 1–4b đã xong**: MCP server v0.1 chạy engine thật (`src/editor.mjs`)
  headless (không Electron/GPU/UI), đã nối vào opencode và có đủ vòng lặp
  authoring → preview → save.
- **Tool MCP hiện có (15):**
  `session_create`, `session_destroy`, `project_new`, `scene_report`,
  `pose_joint`, `keyframe_duplicate`, `undo`, `redo`, `serialize_project`,
  `render_frame` (SVG preview), `render_animation` (animated SVG),
  `save_project` (.styk qua Python codec), `set_frame_duration`, `set_frame_easing`,
  `motion_path_set`, `add_anticipation`.
- **Verify local (Windows)**: `npm run test:mcp` **9/9 pass** (với
  `STYK_PYTHON` trỏ Python 3.11+; máy này dùng `uv run python` 3.14.5).
  `npm run check` pass. CI `unit` (ubuntu) xanh kể cả test MCP mới.
- **CI trên fork đã gọn**: chỉ còn **1 job `unit` (ubuntu)** — `web` và
  `linux-app` bị `if: github.repository_owner == 'filippocalippo'` nên bỏ qua
  trên fork. `desktop-release.yml` không đụng (cần secrets, chỉ tags/dispatch).
- **Đã sửa 1 bug upstream**: `tests/telemetry.test.mjs` fail chỉ trên Windows
  khi chạy qua nửa đêm (dùng `Date.now()` thật). Đã inject base date cố định
  `2026-01-15T12:00:00Z` → deterministic, 11/11 pass.

### Lịch sử commit (trên nhánh)
| Commit | Nội dung |
|---|---|
| `739216af` | Add headless animation authoring proof script (MCP step 0) |
| `ea2fbedc` | CI: skip the Linux packaging job on forks |
| `3275a6de` | CI: drop auto-run on push; run via PR or workflow_dispatch |
| `a3864203` | CI: skip the browser build jobs on forks |
| `3f3870d6` | tests: pin telemetry tests to a fixed base date |
| `35cb26c8` | CI: run unit tests on Ubuntu only on forks |
| `4f593e1b` | Add MCP handoff notes |
| `4170c20a` | MCP Phase 1: tools/server/tests (SDK 1.32.2, zod 4) |
| `7db100e4` | MCP Phase 2: wire stykanimate into opencode project config |
| `1cac1dfe` | MCP Phase 3: render_frame SVG preview tool |
| `4eae8783` | MCP Phase 4: save_project writes real .styk via codec |
| `b2303073` | MCP Phase 4b: set_frame_easing expert tool |
| `591be79f` | MCP Phase 4b: motion_path_set expert tool |
| `4367f5a4` | MCP Phase 4b: render_animation animated SVG tool |
| `bef8e4be` | MCP Phase 4b: add_anticipation expert tool |

## 2. Cách chạy / kiểm tra

```sh
# MCP server (stdio)
node mcp/server.mjs

# Test MCP e2e (bắt buộc pass)
npm run test:mcp

# Python codec cho save_project: set STYK_PYTHON nếu Python không có trên PATH
#   Máy này: STYK_PYTHON="C:\Users\X390\AppData\Roaming\uv\python\cpython-3.14-windows-x86_64-none\python.exe"
#   (lấy bằng `uv run python -c "import sys; print(sys.executable)"`)

# Local checks (một phần của CI unit)
npm run check
node --test tests/telemetry.test.mjs  # bắt buộc 11/11 pass
npm test                              # toàn bộ unit (máy local thiếu `py` → 43 fail codec cũ, CI xanh)
```

### CI trên fork
1. Bật Actions: tab Actions → banner *"I understand my workflows, go ahead and
   enable them"*.
2. Chạy: **Tests → Run workflow → branch `feat/mcp-server`**
   (không có auto-run trên push; chỉ PR nội bộ hoặc run tay).
3. Kỳ vọng: `unit` (ubuntu) ✅ xanh; `web` + `linux-app` ⏭️ skipped.
4. ⚠️ Token GitHub hiện tại **thiếu quyền Actions write** → không rerun/dispatch
   được từ API/MCP; phải bấm từ UI.

## 3. API engine headless (đã xác minh)

- `import {Editor} from '../src/editor.mjs'` — pure ESM, không cần DOM.
- `new Editor({demo:false})` → `editor.load(report)` (report từ `emptyDocument()`
  + `createFrame([createObject(figure, uid, x, y)])`, xem `scripts/build-startup-blue.mjs`).
- `editor.select(uid, jointIndex)` → `editor.poseJoint(x, y, {snap:false})` (IK-aware).
- `editor.seek(tick)` đánh giá pose (kèm easing/inbetween); `editor.geometry`
  cho hình dạng segment (start/end/arc/thickness/rgb) — nguồn cho SVG preview.
- `editor.transaction(label, fn)` = 1 undo group; `editor.beginMotionPathEdit/updateMotionPathEdit/commitMotionPathEdit`
  cho motion-path (translate cả component khi `handleId:0`, pose joint khi `joint+handleId`).
- `editor.duplicateFrame()`, `editor.undo()`, `editor.redo()`, `editor.serialize()`.
- Figure mặc định `defaultFigure()` có **10 segment, không tên**:
  Torso 0 · Head 1 · tay phải 2-3 · tay trái 4-5 · chân phải 6-7 · chân trái 8-9.

## 4. Thiết kế MCP (đã áp dụng)

- Transport **stdio** (không HTTP bind hở); **mọi log ra stderr**, stdout chỉ JSON-RPC.
- **session_id lifecycle**: `session_create` / `session_destroy`; các tool khác
  nhận `session_id`.
- **1 tool = 1 editor command = 1 undo group**.
- **Receipt/diff**: tool trả lại giá trị sau khi ghi (góc, easing, motion-path,
  artifact path) để agent tự kiểm tra (bài học after-effects-mcp: success ≠ written).
- **Input validation + allowlist path**: write chỉ trong workspace / `artifacts/`;
  escape hatch `run_command` **tắt mặc định** (`STYK_MCP_ALLOW_RUN_COMMAND=1`).
- MCP content: `render_frame`/`render_animation` trả image block
  `{type:"image", data: base64, mimeType:"image/svg+xml"}` + text summary.
- `save_project` spawn `codec_bridge.py` qua `resolvePython()` (scripts/run-python.mjs):
  tôn trọng `STYK_PYTHON`, `.venv`, rồi `py`/`python`; bắt buộc đuôi `.styk`.
- opencode: project `opencode.jsonc` (mcp.servers.stykanimate + permission
  `stykanimate_*` allow); config hot-reload, nếu chưa thấy tool → `/reload`.

## 5. Roadmap

| Phase | Trạng thái |
|---|---|
| **1** | ✅ `mcp/tools.mjs` + `mcp/server.mjs` + `tests/mcp-server.test.mjs` (SDK `Client` + `StdioClientTransport`; chạy trong `npm test`). |
| **2** | ✅ Nối opencode: `mcp.servers.stykanimate` + permission `stykanimate_*`. |
| **3** | ✅ Preview loop: `render_frame` SVG; **PNG bitmap còn tùy chọn** (rasterize qua Playwright chromium). |
| **4** | ✅ `save_project` .styk qua codec; ✅ expert tools: `set_frame_easing`, `motion_path_set`, `add_anticipation`. |
| **5** | ✅ Demo kịch bản 15s đã chạy (18 keyframe / 360 tick) — xem §7. |

## 6. Lưu ý quan trọng

- **GPL-3.0**: fork public = distribution → giữ LICENSE/attribution; mọi file mới
  nên có `SPDX-License-Identifier: GPL-3.0-or-later` + ghi ngày người sửa.
- **Không gửi PR lên upstream** (theo yêu cầu); chỉ phát triển trên fork.
- Nếu cần verify web/Windows/release: gỡ guard `if:` tương ứng trong `ci.yml`.
- `artifacts/` đã gitignore — không commit output.
- Test `telemetry.test.mjs` dùng clock inject; đừng đổi lại `Date.now()`.
- `ctxioClientTransport` trong test phải truyền `env: {...process.env}` (server con
  không kế thừa env mặc định).

## 7. Demo kịch bản 15s (Phase 5)

- Script driver: `artifacts/demo/15s.mjs` (chạy `node artifacts/demo/15s.mjs`
  kèm `STYK_PYTHON`) — điều khiển MCP server để dựng **360 tick @ 24fps**.
- Beat (24fps, 1 tick = 1 frame):
  | Beat | Giây | Tick | Nội dung |
  |---|---|---|---|
  | Establish | 0–2 | 0–47 | Blue đi vào từ trái ra giữa (translation) |
  | Trigger | 2–4 | 48–95 | Dừng, nhìn quanh (xoay đầu), giữ |
  | Action | 4–8 | 96–191 | Crouch anticipation → nhảy vọt lên-phải, đấm giữa không trung |
  | Meaning | 8–12 | 192–287 | Tiếp đất (squash) → đứng dậy → pose chiến thắng giơ tay |
  | Finish | 12–15 | 288–359 | Đi ra phải, vẫy tay, thoát |
- Output: `artifacts/demo/15s-anim.svg` (animated SVG, 360 frame @ 24fps, đúng 15s),
  `artifacts/demo/15s.styk` (project thật), và thumb `f0/f4/f6/f9/f12/f16.svg`.
- Ghi chú: dùng `set_frame_duration` cho hold từng keyframe (18 keyframe, tổng 360 tick).
  Engine cap frame **cuối** = 1 tick → nên thêm 1 frame cuối (dur 1) để vừa đủ 15s.
