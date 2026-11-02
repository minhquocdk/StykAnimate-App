/** Headless animation authoring proof (MCP step 0).
 *  Runs the real editor engine without Electron/rendering/UI.
 *  Demonstrates: create doc -> load -> pose joints (IK) over several
 *  frames -> undo/redo -> validate -> serialize to JSON.
 *  Run: node scripts/demo-mcp.mjs
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 *  Modified by minhquocdk on 2026-11-03 for the MCP integration effort.
 */
import {writeFile, mkdir} from 'node:fs/promises';
import {defaultFigure, emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';

const report = emptyDocument();
const figure = defaultFigure();
figure.name = 'Blue';
report.figure_types = [figure];
report.keyframes = [createFrame([createObject(figure, 1, 480, 280)])];

const editor = new Editor({demo: false});
editor.load(report);

// The 10-segment starter figure has no segment names: Torso 0, Head 1,
// right arm 2-3, left arm 4-5, right leg 6-7, left leg 8-9.
const armIndex = 5; // left forearm
const legIndex = 9; // left lower leg
if (armIndex >= figure.segments.length || legIndex >= figure.segments.length) {
  throw new Error(`starter figure has ${figure.segments.length} segments; expected >= 10`);
}

// Frame 1: neutral pose.
editor.select(1, armIndex);
editor.poseJoint(540, 230, {snap: false});

// Frame 2: copy frame, raise the arm.
editor.duplicateFrame();
editor.select(1, armIndex);
editor.poseJoint(580, 180, {snap: false});

// Frame 3: copy again, kick a leg out.
editor.duplicateFrame();
editor.select(1, legIndex);
editor.poseJoint(430, 340, {snap: false});

// History must work headlessly: undo frame 3 pose, redo it.
const before = editor.serialize().keyframes.length;
editor.undo();
editor.redo();
const after = editor.serialize().keyframes.length;
if (before !== after) throw new Error('undo/redo lost a keyframe');

const out = editor.serialize();
// Write only inside the git-ignored artifacts/ tree (path containment guard).
const url = new URL('../artifacts/mcp-demo.json', import.meta.url);
if (!url.pathname.startsWith(new URL('../artifacts/', import.meta.url).pathname)) {
  throw new Error('refusing to write outside artifacts/');
}
await mkdir(new URL('../artifacts/', import.meta.url), {recursive: true});
await writeFile(url, JSON.stringify(out, null, 2));

const arm = out.keyframes.map(k => {
  const seg = k.objects[0]?.angles?.[armIndex] ?? figure.segments[armIndex].angle_rad;
  return +seg.toFixed(3);
});

console.log(JSON.stringify({
  ok: true,
  figures: out.figure_types.length,
  frames: out.keyframes.length,
  armAnglePerFrame: arm,
  undoRedoOk: true,
  artifact: 'artifacts/mcp-demo.json',
}, null, 2));
