/** End-to-end tests for the StykAnimate MCP server (v0.1).
 *  Spawns mcp/server.mjs over stdio (real editor engine, no UI) and drives it
 *  with the official MCP Client. Runs as part of `npm test`.
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 *  Created by minhquocdk on 2026-11-03 for the MCP integration effort.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolvePython } from '../scripts/run-python.mjs';

const serverEntry = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));

async function withClient(callback) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env: { ...process.env } });
  const client = new Client({ name: 'mcp-server-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
  }
}

/** Call a tool and parse its text payload. Throws on JSON-RPC errors. */
async function callText(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { result, data };
}

/** Same as callText but never throws: reports transport/protocol errors too. */
async function callSafe(client, name, args) {
  try {
    return { threw: false, ...(await callText(client, name, args)) };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error) };
  }
}

test('registers the v0.1 tool set', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'keyframe_duplicate', 'pose_joint', 'project_new', 'redo', 'render_frame', 'run_command', 'save_project',
      'scene_report', 'serialize_project', 'session_create', 'session_destroy', 'undo',
    ]);
  });
});

test('headless authoring flow over stdio (project -> pose -> duplicate -> undo/redo)', async () => {
  await withClient(async (client) => {
    const created = (await callText(client, 'session_create', {})).data;
    assert.equal(created.ok, true);
    const sid = created.session_id;
    assert.ok(sid, 'session_id returned');

    const proj = (await callText(client, 'project_new', { session_id: sid })).data;
    assert.equal(proj.ok, true);
    assert.equal(proj.frame_count, 1);

    let report = (await callText(client, 'scene_report', { session_id: sid })).data;
    assert.equal(report.ok, true);
    assert.equal(report.frame_count, 1);
    assert.equal(report.frames[0].objects.length, 1);
    assert.equal(report.figures.length, 1);
    assert.equal(report.figures[0].name, 'Blue');
    assert.equal(report.figures[0].segments.length, 10);

    const forearm = report.figures[0].segments.find((s) => s.name === 'Left forearm');
    assert.ok(forearm, 'named segment present in scene_report');
    const beforeAngle = report.frames[0].objects[0].angles[forearm.index];

    const pose = (await callText(client, 'pose_joint', {
      session_id: sid, uid: 1, joint_index: forearm.index, x: 580, y: 180,
    })).data;
    assert.equal(pose.ok, true);
    assert.equal(pose.joint_name, 'Left forearm');
    assert.equal(pose.changed, true, 'pose wrote an angle');
    assert.equal(pose.angle_before, beforeAngle);
    assert.notEqual(pose.angle_after, pose.angle_before);

    const dup = (await callText(client, 'keyframe_duplicate', { session_id: sid })).data;
    assert.equal(dup.ok, true);
    assert.equal(dup.duplicated, true);
    assert.equal(dup.frame_count, 2);

    report = (await callText(client, 'scene_report', { session_id: sid })).data;
    assert.equal(report.frame_count, 2);
    assert.deepEqual(report.frames[1].objects[0].angles, report.frames[0].objects[0].angles, 'duplicate starts identical');

    // Pose only the second frame; the first must stay untouched.
    const pose2 = (await callText(client, 'pose_joint', {
      session_id: sid, frame_index: 1, uid: 1, joint_index: 2, x: 520, y: 230,
    })).data;
    assert.equal(pose2.changed, true);
    report = (await callText(client, 'scene_report', { session_id: sid })).data;
    assert.notDeepEqual(report.frames[1].objects[0].angles, report.frames[0].objects[0].angles);

    const undone = (await callText(client, 'undo', { session_id: sid })).data;
    assert.equal(undone.applied, true);
    assert.equal(undone.can_redo, true);
    report = (await callText(client, 'scene_report', { session_id: sid })).data;
    assert.deepEqual(report.frames[1].objects[0].angles, report.frames[0].objects[0].angles, 'undo reverts the frame-1 pose');

    const redone = (await callText(client, 'redo', { session_id: sid })).data;
    assert.equal(redone.applied, true);
    assert.equal(redone.can_undo, true);

    const serialized = (await callText(client, 'serialize_project', { session_id: sid })).data;
    assert.equal(serialized.ok, true);
    assert.equal(serialized.document.keyframes.length, 2);
    assert.equal(serialized.document._styk.format, 'StykAnimate');

    const destroyed = (await callText(client, 'session_destroy', { session_id: sid })).data;
    assert.equal(destroyed.ok, true);
    assert.equal(destroyed.destroyed, true);

    const afterDestroy = await callSafe(client, 'scene_report', { session_id: sid });
    assert.ok(afterDestroy.threw || afterDestroy.result?.isError, 'session is gone after destroy');
  });
});

test('validates input and isolates sessions', async () => {
  await withClient(async (client) => {
    const bad = await callSafe(client, 'scene_report', { session_id: 'nope' });
    assert.ok(bad.threw || bad.result?.isError, 'unknown session is an error');

    const sid = (await callText(client, 'session_create', {})).data.session_id;
    await callText(client, 'project_new', { session_id: sid });
    const initial = (await callText(client, 'scene_report', { session_id: sid })).data;
    const initialArm = initial.frames[0].objects[0].angles[0];

    const badPose = await callSafe(client, 'pose_joint', { session_id: sid, uid: 1, joint_index: 99, x: 1, y: 1 });
    assert.ok(badPose.threw || badPose.result?.isError, 'joint_index out of range is an error');

    // A second session is independent: posing in sid must not touch sid2.
    const sid2 = (await callText(client, 'session_create', {})).data.session_id;
    await callText(client, 'project_new', { session_id: sid2 });
    await callText(client, 'pose_joint', { session_id: sid, uid: 1, joint_index: 0, x: 400, y: 300 });
    const report2 = (await callText(client, 'scene_report', { session_id: sid2 })).data;
    assert.equal(report2.frames[0].objects[0].angles[0], initialArm, 'sessions do not share editor state');

    // Escape hatch is off by default.
    const rc = await callSafe(client, 'run_command', { session_id: sid, command: 'echo' });
    assert.ok(rc.threw || rc.result?.isError, 'run_command disabled by default');

    await callText(client, 'session_destroy', { session_id: sid });
    await callText(client, 'session_destroy', { session_id: sid2 });
  });
});

test('render_frame returns a viewable SVG preview and writes artifacts safely', async () => {
  await withClient(async (client) => {
    const sid = (await callText(client, 'session_create', {})).data.session_id;
    await callText(client, 'project_new', { session_id: sid });
    await callText(client, 'pose_joint', { session_id: sid, uid: 1, joint_index: 5, x: 580, y: 180 });

    const res = await client.callTool({ name: 'render_frame', arguments: { session_id: sid } });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    const summary = JSON.parse(text);
    assert.equal(summary.ok, true);
    assert.equal(summary.format, 'svg');
    assert.equal(summary.width, 960);
    assert.equal(summary.height, 540);
    assert.ok(summary.segments > 0, 'frame draws at least one primitive');

    const image = res.content.find((c) => c.type === 'image');
    assert.ok(image, 'render_frame returns an image content block');
    assert.equal(image.mimeType, 'image/svg+xml');
    const svg = Buffer.from(image.data, 'base64').toString('utf8');
    assert.ok(svg.startsWith('<svg'), 'decoded SVG starts with <svg');
    assert.ok(svg.includes('<polyline') || svg.includes('<circle'), 'SVG contains drawn primitives');

    // Optional artifact write stays inside artifacts/.
    const withFile = await client.callTool({ name: 'render_frame', arguments: { session_id: sid, output: 'preview/frame-0.svg' } });
    const fileSummary = JSON.parse(withFile.content.find((c) => c.type === 'text')?.text ?? '{}');
    assert.equal(fileSummary.artifact, 'artifacts/preview/frame-0.svg');

    const refused = await callSafe(client, 'render_frame', { session_id: sid, output: '../outside.svg' });
    assert.ok(refused.threw || refused.result?.isError, 'writing outside artifacts/ is refused');

    await callText(client, 'session_destroy', { session_id: sid });
  });
});

test('save_project writes a real .styk through the Python codec', async (t) => {
  if (!resolvePython()) return t.skip('Python 3.11+ not available; set STYK_PYTHON to run');
  await withClient(async (client) => {
    const sid = (await callText(client, 'session_create', {})).data.session_id;
    await callText(client, 'project_new', { session_id: sid });
    await callText(client, 'pose_joint', { session_id: sid, uid: 1, joint_index: 5, x: 580, y: 180 });

    const saved = (await callText(client, 'save_project', { session_id: sid, destination: 'artifacts/preview/test.styk' })).data;
    assert.equal(saved.ok, true, `save_project response: ${JSON.stringify(saved)}`);
    assert.equal(saved.format, 'styk');
    assert.ok(saved.path.endsWith('test.styk'));
    assert.ok(saved.bytes > 0, 'wrote non-empty .styk');

    // Guard: destination outside the workspace is refused.
    const refused = await callSafe(client, 'save_project', { session_id: sid, destination: '../escape.styk' });
    assert.ok(refused.threw || refused.result?.isError, 'writing outside workspace is refused');

    // Guard: wrong extension is refused.
    const badExt = await callSafe(client, 'save_project', { session_id: sid, destination: 'artifacts/preview/test.txt' });
    assert.ok(badExt.threw || badExt.result?.isError, 'non-.styk destination is refused');

    await callText(client, 'session_destroy', { session_id: sid });
  });
});
