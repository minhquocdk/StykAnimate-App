# Handoff — MCP integration for StykAnimate

> Ngày: 2026-11-03 · Nhánh: `feat/mcp-server` · Fork: https://github.com/minhquocdk/StykAnimate-App
> Mục tiêu: để AI (opencode/Claude) tạo và chỉnh sửa animation trong StykAnimate qua MCP.

## 1. Trạng thái hiện tại

- **Step 0 đã xong (chứng minh luồng headless)**: `scripts/demo-mcp.mjs`
  chạy engine thật (`src/editor.mjs`) trong Node **không cần Electron/GPU/UI**:
  tạo document → thêm figure → pose joint qua IK → nhân keyframe → undo/redo →
  serialize JSON. Output vào `artifacts/mcp-demo.json` (đã gitignore).
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

## 2. Cách chạy / kiểm tra

```sh
# Proof script (step 0)
node scripts/demo-mcp.mjs            # -> artifacts/mcp-demo.json

# Local checks (một phần của CI unit)
npm run check
node --test tests/telemetry.test.mjs  # bắt buộc 11/11 pass
npm test                              # toàn bộ unit
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
- `editor.duplicateFrame()`, `editor.undo()`, `editor.redo()`, `editor.serialize()`.
- Figure mặc định `defaultFigure()` có **10 segment, không tên**:
  Torso 0 · Head 1 · tay phải 2-3 · tay trái 4-5 · chân phải 6-7 · chân trái 8-9.

## 4. Thiết kế MCP (đã research, áp dụng cho Phase 1)

- Transport **stdio** (không HTTP bind hở); **mọi log ra stderr**, stdout chỉ JSON-RPC.
- **session_id lifecycle**: `session_create` / `session_destroy`; các tool khác
  nhận `session_id`.
- **1 tool = 1 editor command = 1 undo group**; nếu có batch → phải atomic 1 undo.
- **Receipt/diff**: sau `pose_joint` trả lại joint angles mới để agent tự kiểm tra
  (bài học after-effects-mcp: success ≠ written).
- **Input validation + allowlist path**; escape hatch (`run_command`) để **tắt mặc định**.
- Tool v0.1 đề xuất: `session_create`, `session_destroy`, `project_new`,
  `scene_report`, `pose_joint`, `keyframe_duplicate`, `undo`, `redo`, `serialize_project`.

## 5. Roadmap

| Phase | Nội dung |
|---|---|
| **1** | `mcp/tools.mjs` + `mcp/server.mjs` + `tests/mcp-server.test.mjs` (SDK `Client` + `StdioClientTransport`; test tự chạy trong `npm test`). Thêm dep `@modelcontextprotocol/sdk` (devDependencies). |
| **2** | Nối vào opencode: `mcp.servers.stykanimate` (`type: local`, `command: ["node","mcp/server.mjs"]`), permission gating `stykanimate_*`. |
| **3** | Preview loop: export frame → PNG/SVG để AI nhìn kết quả. |
| **4** | Save `.styk` thật qua codec; expert tools (easing/anticipation/motion path). |

## 6. Lưu ý quan trọng

- **GPL-3.0**: fork public = distribution → giữ LICENSE/attribution; mọi file mới
  nên có `SPDX-License-Identifier: GPL-3.0-or-later` + ghi ngày người sửa.
- **Không gửi PR lên upstream** (theo yêu cầu); chỉ phát triển trên fork.
- Nếu cần verify web/Windows/release: gỡ guard `if:` tương ứng trong `ci.yml`.
- `artifacts/` đã gitignore — không commit output.
- Test `telemetry.test.mjs` dùng clock inject; đừng đổi lại `Date.now()`.
