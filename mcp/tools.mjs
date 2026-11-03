/** MCP tool definitions for StykAnimate (v0.1).
 *  Each tool maps to one editor command / one undo group; batch flows must stay
 *  one undo group. A session owns one headless Editor; state never leaves the
 *  process. Logs go to stderr; stdout carries only JSON-RPC.
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 *  Created by minhquocdk on 2026-11-03 for the MCP integration effort.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolvePython } from '../scripts/run-python.mjs';
import { easingMode, validateKeyEasing } from '../src/keyframe-easing.mjs';
import { Editor } from '../src/editor.mjs';
import { defaultFigure, emptyDocument, createFrame, createObject } from '../src/demo.mjs';

/** The starter figure has 10 segments, in this order (index = segment index). */
const SEGMENT_NAMES = [
  'Torso', 'Head', 'Left upper arm', 'Left forearm', 'Right upper arm',
  'Right forearm', 'Left thigh', 'Left lower leg', 'Right thigh', 'Right lower leg',
];

const sessionStore = new Map();

export function createSession() {
  const id = randomUUID();
  sessionStore.set(id, { id, editor: new Editor({ demo: false }) });
  return id;
}

export function destroySession(id) {
  return sessionStore.delete(id);
}

function requireSession(id) {
  const session = sessionStore.get(id);
  if (!session) throw new Error(`unknown session_id: ${id}`);
  return session;
}

/** Fresh ordinary 2D "Blue" project: one named figure, one keyframe. */
function buildBlueReport() {
  const figure = defaultFigure();
  figure.name = 'Blue';
  const thickness = [16, 0, 12, 12, 12, 12, 14, 14, 14, 14];
  for (const [i, segment] of figure.segments.entries()) {
    Object.assign(segment, { name: SEGMENT_NAMES[i], thickness: thickness[i], color_rgb: [13, 153, 255] });
  }
  Object.assign(figure.segments[1], { primitive_code: 3, flags: 3, segment_kind: 'circleFill' });
  // Mirror the limbs with separated handles (native angles are absolute).
  for (const [left, right] of [[2, 4], [3, 5], [6, 8], [7, 9]]) {
    figure.segments[right].angle_rad = Math.PI - figure.segments[left].angle_rad;
  }
  const report = emptyDocument();
  report.figure_types = [figure];
  report.keyframes = [createFrame([createObject(figure, 1, 480, 280)])];
  return report;
}

const round = (value) => +Number(value).toFixed(4);

function sceneReport(session) {
  const { editor } = session;
  const doc = editor.serialize();
  const figureMap = new Map(doc.figure_types.map((f) => [f.figure_type_id, f]));
  return {
    ok: true,
    name: editor.name,
    canvas_width: doc.canvas_width,
    canvas_height: doc.canvas_height,
    fps: doc.fps,
    frame_index: editor.frameIndex,
    frame_count: doc.keyframes.length,
    can_undo: editor.canUndo,
    can_redo: editor.canRedo,
    figures: [...figureMap.values()].map((figure) => ({
      figure_type_id: figure.figure_type_id,
      name: figure.name,
      segments: figure.segments.map((segment, index) => ({
        index,
        segment_id: segment.segment_id,
        name: segment.name ?? null,
        length: segment.length,
        thickness: segment.thickness,
        angle_rad: round(segment.angle_rad),
      })),
    })),
    frames: doc.keyframes.map((frame, frameIndex) => ({
      index: frameIndex,
      duration_raw: frame.duration_raw,
      easing: frame._styk?.easing ? { interpolation: easingMode(frame._styk.easing), ...(frame._styk.easing.bezier ? { bezier: frame._styk.easing.bezier } : {}) } : null,
      objects: frame.objects.map((object) => ({
        unique_id: object.unique_id,
        figure_type_id: object.figure_type_id,
        figure_name: figureMap.get(object.figure_type_id)?.name ?? null,
        root_x: object.root_x,
        root_y: object.root_y,
        angles: object.angles.map(round),
      })),
    })),
  };
}

function projectNew(session) {
  const { editor } = session;
  editor.load(buildBlueReport());
  return { ok: true, name: editor.name, frame_count: editor.report.keyframes.length };
}

function poseJoint(session, args) {
  const { editor } = session;
  if (args.frame_index !== undefined) editor.selectFrame(args.frame_index);
  const frame = editor.frame;
  const object = frame.objects.find((o) => o.unique_id === args.uid);
  if (!object) throw new Error(`no object with unique_id ${args.uid} on frame ${editor.frameIndex}`);
  const figure = editor.report.figure_types.find((f) => f.figure_type_id === object.figure_type_id);
  if (!figure) throw new Error(`figure type ${object.figure_type_id} not found`);
  if (!Number.isInteger(args.joint_index) || args.joint_index < 0 || args.joint_index >= figure.segments.length) {
    throw new Error(`joint_index ${args.joint_index} out of range 0..${figure.segments.length - 1}`);
  }
  const segment = figure.segments[args.joint_index];
  const before = object.angles[args.joint_index];
  editor.select(args.uid, args.joint_index);
  const result = editor.poseJoint(args.x, args.y, { snap: false });
  const after = editor.frame.objects.find((o) => o.unique_id === args.uid)?.angles?.[args.joint_index] ?? before;
  return {
    ok: true,
    uid: args.uid,
    frame_index: editor.frameIndex,
    joint_index: args.joint_index,
    joint_name: segment.name ?? null,
    x: args.x,
    y: args.y,
    angle_before: round(before),
    angle_after: round(after),
    changed: Math.abs(after - before) > 1e-9 && result !== false,
  };
}

function keyframeDuplicate(session, args) {
  const { editor } = session;
  if (args.frame_index !== undefined) editor.selectFrame(args.frame_index);
  const beforeCount = editor.report.keyframes.length;
  editor.duplicateFrame();
  const afterCount = editor.report.keyframes.length;
  return { ok: true, frame_index: editor.frameIndex, frame_count: afterCount, duplicated: afterCount === beforeCount + 1 };
}

function undo(session) {
  const { editor } = session;
  const label = editor.undoLabel;
  const applied = editor.undo() !== false;
  return { ok: true, applied, label: label || null, can_undo: editor.canUndo, can_redo: editor.canRedo, frame_count: editor.report.keyframes.length };
}

function redo(session) {
  const { editor } = session;
  const label = editor.redoLabel;
  const applied = editor.redo() !== false;
  return { ok: true, applied, label: label || null, can_undo: editor.canUndo, can_redo: editor.canRedo, frame_count: editor.report.keyframes.length };
}

function serializeProject(session) {
  return { ok: true, document: session.editor.serialize() };
}

function runCommand() {
  if (process.env.STYK_MCP_ALLOW_RUN_COMMAND !== '1') {
    throw new Error('run_command is disabled by default; set STYK_MCP_ALLOW_RUN_COMMAND=1 to enable');
  }
  throw new Error('run_command is not implemented in v0.1');
}

const r2 = (value) => Math.round(Number(value) * 100) / 100;

/** Vector preview from the headless geometry: lines become polyline strokes,
 *  circles (head) become filled/stroked circles. Skips images/text/polygons. */
function frameDrawElements(editor) {
  const doc = editor.serialize();
  const width = Number(doc.canvas_width ?? 960);
  const height = Number(doc.canvas_height ?? 540);
  const frame = editor.frame;
  const order = new Map((frame.object_draw_order_unique_ids ?? []).map((uid, i) => [uid, i]));
  const draws = [];
  let slot = 0;
  for (const [, g] of editor.geometry.objects) {
    const zBase = (order.get(g.obj?.unique_id) ?? slot) * 1000;
    for (const s of g.segments) {
      if (!s || s.seg?.visible === false) continue;
      const color = s.rgb ? `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})` : '#000';
      const alpha = s.alpha ?? 1;
      const stroke = alpha < 1 ? `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${r2(alpha)})` : color;
      const w = Number(s.thickness) || 0;
      if (s.type === 'line') {
        if (w <= 0 || !s.points || s.points.length < 2) continue;
        const pts = s.points.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' ');
        draws.push({ z: zBase + Number(s.z ?? 0), el: `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${r2(w)}" stroke-linecap="round" stroke-linejoin="round"/>` });
      } else if (s.type === 'circle') {
        const len = Math.abs(Number(s.length) || 0);
        const filled = s.seg?.segment_kind === 'circleFill' || w >= len;
        const radius = r2((len + (filled ? w : 0)) / 2);
        if (!radius) continue;
        const cx = r2((s.start.x + s.end.x) / 2);
        const cy = r2((s.start.y + s.end.y) / 2);
        const el = filled
          ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${stroke}"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#fff" stroke="${stroke}" stroke-width="${r2(w)}"/>`;
        draws.push({ z: zBase + Number(s.z ?? 0), el });
      }
    }
    slot++;
  }
  draws.sort((a, b) => a.z - b.z);
  return { width, height, elements: draws.map((d) => d.el), segments: draws.length };
}

function sceneToSvg(editor) {
  const { width, height, elements, segments } = frameDrawElements(editor);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join('')}</svg>`, width, height, segments };
}

const r4 = (value) => Number(value.toFixed(4));

async function renderAnimation(session, args) {
  const { editor } = session;
  const total = editor.totalTicks;
  const start = args.start_tick ?? 0;
  const end = args.end_tick ?? Math.max(0, total - 1);
  if (start < 0 || end >= total || start > end) {
    throw new Error(`tick range ${start}..${end} outside timeline 0..${Math.max(0, total - 1)}`);
  }
  const fps = Number(args.fps) || editor.report.fps || 24;
  const requested = end - start + 1;
  const step = Math.max(1, Math.ceil(requested / (args.max_frames ?? 96)));
  const ticks = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  if (ticks.at(-1) !== end) ticks.push(end);
  const N = ticks.length;
  let first = null;
  const frames = [];
  for (const tick of ticks) {
    editor.seek(tick);
    const fr = frameDrawElements(editor);
    first ??= fr;
    frames.push({ fr, k0: frames.length / N, k1: (frames.length + 1) / N });
  }
  let elements;
  if (N === 1) {
    elements = first.elements;
  } else {
    const T = N / fps;
    elements = frames.map(({ fr, k0, k1 }) =>
      `<g><animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;${r4(k0)};${r4(k1)}" dur="${r4(T)}s" repeatCount="indefinite"/>${fr.elements.join('')}</g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${first.width}" height="${first.height}" viewBox="0 0 ${first.width} ${first.height}">${elements.join('')}</svg>`;
  const summary = {
    ok: true,
    format: 'svg-animation',
    frames: N,
    fps,
    duration_seconds: r4(N / fps),
    start_tick: start,
    end_tick: end,
    sampled_ticks: ticks.slice(0, 32),
    width: first.width,
    height: first.height,
  };
  const content = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
  if (args.output) {
    summary.artifact = await writeArtifact(String(args.output), svg);
    content[0] = { type: 'text', text: JSON.stringify(summary, null, 2) };
  }
  content.push({ type: 'image', data: Buffer.from(svg, 'utf8').toString('base64'), mimeType: 'image/svg+xml' });
  return { content };
}

async function writeArtifact(rel, text) {
  const root = new URL('../artifacts/', import.meta.url);
  const target = new URL(rel, root);
  if (!target.pathname.startsWith(root.pathname)) throw new Error(`refusing to write outside artifacts/: ${rel}`);
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, text);
  return `artifacts/${rel.replaceAll('\\', '/')}`;
}

async function renderFrame(session, args) {
  const { editor } = session;
  if (args.frame_index !== undefined) editor.selectFrame(args.frame_index);
  const { svg, width, height, segments } = sceneToSvg(editor);
  const summary = { ok: true, format: 'svg', frame_index: editor.frameIndex, width, height, segments };
  const text = JSON.stringify(summary, null, 2);
  const content = [{ type: 'text', text }];
  if (args.output) {
    summary.artifact = await writeArtifact(String(args.output), svg);
    content[0] = { type: 'text', text: JSON.stringify(summary, null, 2) };
  }
  content.push({ type: 'image', data: Buffer.from(svg, 'utf8').toString('base64'), mimeType: 'image/svg+xml' });
  return { content };
}

async function saveProject(session, args) {
  const { editor } = session;
  const appRoot = new URL('../', import.meta.url);
  const dest = new URL(String(args.destination), appRoot);
  if (!dest.pathname.startsWith(appRoot.pathname)) throw new Error(`destination outside workspace: ${args.destination}`);
  if (!dest.pathname.toLowerCase().endsWith('.styk')) throw new Error('destination must end with .styk');
  const python = resolvePython();
  if (!python) throw new Error('Python 3.11+ not found; set STYK_PYTHON to a python executable (e.g. `uv run python`)');
  await mkdir(new URL('.', dest), { recursive: true });
  const tmpDir = new URL('../artifacts/codec-tmp/', import.meta.url);
  await mkdir(tmpDir, { recursive: true });
  const id = randomUUID();
  const reqFile = new URL(`${id}-req.json`, tmpDir);
  const respFile = new URL(`${id}-resp.json`, tmpDir);
  try {
    const request = { operation: 'save', document: editor.serialize(), destination: fileURLToPath(dest) };
    await writeFile(reqFile, JSON.stringify(request));
    const spawned = spawnSync(python.command, [...python.args, 'codecs/codec_bridge.py', '--request', fileURLToPath(reqFile), '--response', fileURLToPath(respFile)], {
      cwd: fileURLToPath(appRoot), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    const raw = await readFile(respFile, 'utf8').catch(() => null);
    const response = raw ? JSON.parse(raw) : null;
    if (!response?.ok) throw new Error(response?.error ?? `codec failed (exit ${spawned.status})`);
    const size = (await stat(fileURLToPath(dest))).size;
    return { ok: true, format: response.format, path: response.path, bytes: size };
  } finally {
    await unlink(fileURLToPath(reqFile)).catch(() => {});
    await unlink(fileURLToPath(respFile)).catch(() => {});
  }
}

async function setFrameEasing(session, args) {
  const { editor } = session;
  if (args.frame_index !== undefined) editor.selectFrame(args.frame_index);
  const index = editor.frameIndex;
  const interpolation = args.interpolation === 'hold' ? 'constant' : args.interpolation;
  const easing = { interpolation };
  if (interpolation === 'bezier') easing.bezier = args.bezier ?? [0.42, 0, 0.58, 1];
  validateKeyEasing(easing);
  const changed = editor.transaction('Set keyframe easing', (frame) => {
    frame._styk = { ...frame._styk, easing };
  });
  return {
    ok: true,
    frame_index: index,
    interpolation: easingMode(easing),
    ...(easing.bezier ? { bezier: easing.bezier } : {}),
    changed: changed !== false,
  };
}

async function motionPathSet(session, args) {
  const { editor } = session;
  const holder = editor.report.keyframes.find((frame) => frame.objects.some((o) => o.unique_id === args.uid));
  if (!holder) throw new Error(`no object with unique_id ${args.uid}`);
  const object = holder.objects.find((o) => o.unique_id === args.uid);
  const figure = editor.report.figure_types.find((f) => f.figure_type_id === object.figure_type_id);
  if (!figure) throw new Error(`figure type ${object.figure_type_id} not found`);
  let target;
  if (args.joint_index != null) {
    if (!Number.isInteger(args.joint_index) || args.joint_index < 0 || args.joint_index >= figure.segments.length) {
      throw new Error(`joint_index ${args.joint_index} out of range 0..${figure.segments.length - 1}`);
    }
    const segment = figure.segments[args.joint_index];
    target = { kind: 'node', uid: args.uid, joint: args.joint_index, handleId: segment.segment_id };
  } else {
    target = { kind: 'node', uid: args.uid, handleId: 0 }; // translate the whole connected component
  }
  if (!editor.beginMotionPathEdit(target, args.tick)) {
    throw new Error('begin motion path failed (tick outside timeline or invalid target)');
  }
  try {
    if (editor.updateMotionPathEdit({ x: args.x, y: args.y }) === false) throw new Error('update motion path failed');
    const committed = editor.commitMotionPathEdit() !== false;
    return {
      ok: true,
      uid: args.uid,
      tick: args.tick,
      x: args.x,
      y: args.y,
      joint_index: args.joint_index ?? null,
      mode: args.joint_index != null ? 'joint' : 'translation',
      changed: committed,
      frame_index: editor.frameIndex,
      frame_count: editor.report.keyframes.length,
    };
  } catch (error) {
    editor.cancelMotionPathEdit();
    throw error;
  }
}

const defineTool = (name, description, schema, handler) => ({ name, description, schema, handler });

const tools = [
  defineTool('session_create', 'Create a new headless editing session. Returns a session_id that every other tool requires.', z.object({}), async () => {
    const session_id = createSession();
    return { ok: true, session_id };
  }),
  defineTool('session_destroy', 'Destroy a session and free its editor.', z.object({ session_id: z.string() }), async (args) => {
    const destroyed = destroySession(args.session_id);
    if (!destroyed) throw new Error(`unknown session_id: ${args.session_id}`);
    return { ok: true, destroyed };
  }),
  defineTool('project_new', 'Load a fresh blue stick-figure project (10 named segments, one figure, one keyframe) into the session.', z.object({ session_id: z.string() }), async (args) => projectNew(requireSession(args.session_id))),
  defineTool('scene_report', 'Return a structured snapshot of the current project: figures, segment names/indexes, per-frame object poses, undo/redo state.', z.object({ session_id: z.string() }), async (args) => sceneReport(requireSession(args.session_id))),
  defineTool('pose_joint', 'Pose one joint (IK-aware) to coordinates x,y on the given frame. Returns the resulting joint angle as a receipt.', z.object({
    session_id: z.string(),
    frame_index: z.number().int().min(0).optional().describe('Frame to pose (defaults to the current frame)'),
    uid: z.number().int().positive().describe('unique_id of the object to pose'),
    joint_index: z.number().int().min(0).describe('Segment index within the figure (see scene_report)'),
    x: z.number().describe('Target x in document coordinates'),
    y: z.number().describe('Target y in document coordinates'),
  }), async (args) => poseJoint(requireSession(args.session_id), args)),
  defineTool('keyframe_duplicate', 'Duplicate a keyframe (defaults to the current frame) as one undo group.', z.object({ session_id: z.string(), frame_index: z.number().int().min(0).optional() }), async (args) => keyframeDuplicate(requireSession(args.session_id), args)),
  defineTool('motion_path_set', 'Move an object (translation) or pose one of its joints at a specific timeline tick, rewriting that point of its motion path. One undo group. Omit joint_index to translate the whole connected component.', z.object({
    session_id: z.string(),
    uid: z.number().int().positive().describe('unique_id of the object to move'),
    tick: z.number().int().min(0).describe('Timeline tick whose motion-path point to rewrite (0-based)'),
    x: z.number().describe('Destination x in document coordinates'),
    y: z.number().describe('Destination y in document coordinates'),
    joint_index: z.number().int().min(0).optional().describe('Segment index to pose instead of translating the object root'),
  }), async (args) => motionPathSet(requireSession(args.session_id), args)),
  defineTool('undo', 'Undo the previous editor command.', z.object({ session_id: z.string() }), async (args) => undo(requireSession(args.session_id))),
  defineTool('redo', 'Redo the last undone editor command.', z.object({ session_id: z.string() }), async (args) => redo(requireSession(args.session_id))),
  defineTool('serialize_project', 'Return the full serialized project document.', z.object({ session_id: z.string() }), async (args) => serializeProject(requireSession(args.session_id))),
  defineTool('render_frame', 'Render the current (or given) frame to an SVG vector preview so the AI can visually verify poses. Returns an image content block plus a text summary; optionally writes the SVG under artifacts/.', z.object({
    session_id: z.string(),
    frame_index: z.number().int().min(0).optional().describe('Frame to render (defaults to the current frame)'),
    output: z.string().optional().describe('Relative path under artifacts/ to also write the SVG (e.g. preview/frame-0.svg)'),
  }), async (args) => renderFrame(requireSession(args.session_id), args)),
  defineTool('render_animation', 'Render a playable animated SVG of the timeline segment [start_tick..end_tick], sampling the real evaluated engine (including easing/inbetweens) at the project fps. Returns an image block plus summary; optionally writes under artifacts/.', z.object({
    session_id: z.string(),
    start_tick: z.number().int().min(0).optional().describe('First tick to sample (defaults to 0)'),
    end_tick: z.number().int().min(0).optional().describe('Last tick to sample (defaults to the last tick)'),
    fps: z.number().positive().optional().describe('Frames per second for the animation (defaults to project fps)'),
    max_frames: z.number().int().positive().max(512).optional().describe('Maximum frames to sample (defaults to 96)'),
    output: z.string().optional().describe('Relative path under artifacts/ to also write the SVG (e.g. preview/anim.svg)'),
  }), async (args) => renderAnimation(requireSession(args.session_id), args)),
  defineTool('save_project', 'Save the session project as a real .styk file through the native Python codec. Destination must end in .styk and stay inside the repository workspace. Requires Python 3.11+ (set STYK_PYTHON if not on PATH).', z.object({
    session_id: z.string(),
    destination: z.string().describe('Relative path from the repo root (e.g. out/anim.styk); must stay inside the workspace'),
  }), async (args) => saveProject(requireSession(args.session_id), args)),
  defineTool('set_frame_easing', 'Set the easing curve of a keyframe (the timing between this and the next frame): auto, linear, constant (hold), ease-in, ease-out, or bezier (with optional four control points). One undo group.', z.object({
    session_id: z.string(),
    frame_index: z.number().int().min(0).optional().describe('Frame to set (defaults to the current frame)'),
    interpolation: z.enum(['auto', 'linear', 'constant', 'hold', 'ease-in', 'ease-out', 'bezier']),
    bezier: z.array(z.number().min(0).max(1)).length(4).optional().describe('Cubic bezier control points [x1,y1,x2,y2] (required only for bezier)'),
  }), async (args) => setFrameEasing(requireSession(args.session_id), args)),
  defineTool('run_command', 'Escape hatch for arbitrary editor commands. Disabled by default; refuses to run unless STYK_MCP_ALLOW_RUN_COMMAND=1 is set.', z.object({ session_id: z.string(), command: z.string(), args: z.array(z.unknown()).optional() }), async (args) => runCommand(requireSession(args.session_id), args)),
];

export function registerTools(server) {
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args) => {
      try {
        const payload = await tool.handler(args);
        if (payload && Array.isArray(payload.content)) return { content: payload.content };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    });
  }
}
