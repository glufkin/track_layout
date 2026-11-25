// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../../src/ui/app';
import type { Pose, Vec2 } from '../../src/geom/vec';
import { type Piece, emptyLayout } from '../../src/model/types';
import { attachSpec, outPose, specToPiece } from '../../src/sketch/spec';
import { samplePath } from '../../src/geom/path';
import { worldRoutePath } from '../../src/track/graph';
import { worldToScreen } from '../../src/render/camera';
import { R_M } from '../../src/track/catalog';
import { AUTOSAVE_KEY } from '../../src/io/serialize';

let app: App;
let canvas: HTMLCanvasElement;

beforeEach(() => {
  localStorage.clear();
  // jsdom has no canvas 2D context; App and palette must tolerate null.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root);
  canvas = app.canvas;
});

afterEach(() => { app.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

const pointer = (type: string, at: Vec2, o: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { clientX: at.x, clientY: at.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, ...o });

function click(at: Vec2, o: PointerEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointermove', at, { buttons: 0 }));
  canvas.dispatchEvent(pointer('pointerdown', at, o));
  canvas.dispatchEvent(pointer('pointerup', at, o));
}

function drag(from: Vec2, to: Vec2, o: PointerEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointerdown', from, o));
  canvas.dispatchEvent(pointer('pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, o));
  canvas.dispatchEvent(pointer('pointermove', to, o));
  canvas.dispatchEvent(pointer('pointerup', to, o));
}

const key = (k: string, o: KeyboardEventInit = {}, target: EventTarget = window): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
};

/** Screen point on the middle of a piece's route. */
function onPiece(id: string, route = 0, frac = 0.5): Vec2 {
  const p = app.doc.piece(id)!;
  const path = worldRoutePath(p, route);
  return worldToScreen(app.camera, app.viewSize(), samplePath(path, path.length * frac).pos);
}

const place = (type: string): void => {
  app.input.mode = { kind: 'place', type, flipped: false, attachIndex: 0, freeRot: 0 };
};

test('Ctrl-Z undoes the last placement; Ctrl-Shift-Z and Ctrl-Y redo', () => {
  place('curve-m-45');
  click({ x: 40, y: 40 });
  expect(app.doc.layout.pieces).toHaveLength(1);
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(0);
  key('Z', { ctrlKey: true, shiftKey: true });
  expect(app.doc.layout.pieces).toHaveLength(1);
  key('z', { metaKey: true });
  expect(app.doc.layout.pieces).toHaveLength(0);
  key('y', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(1);
});

test('Ctrl-Z in a focused input does not undo', () => {
  place('curve-m-45');
  click({ x: 40, y: 40 });
  for (const tag of ['input', 'select', 'textarea']) {
    const el = document.createElement(tag);
    document.body.append(el);
    key('z', { ctrlKey: true }, el);
    key('Delete', {}, el);
    key('Escape', {}, el);
  }
  expect(app.doc.layout.pieces).toHaveLength(1);
  expect(app.input.mode.kind).toBe('place');
});

test('keep-placing: second click attaches to the first piece', () => {
  place('curve-m-45');
  click({ x: 40, y: 40 });
  click({ x: 40, y: 40 });
  const [a, b] = app.doc.layout.pieces;
  expect(app.doc.layout.pieces).toHaveLength(2);
  const joinedToA = [...app.doc.graph.joins.values()].filter((c) => c.pieceId === a.id);
  expect(joinedToA.length).toBe(1);
  expect(app.doc.graph.joins.size).toBe(2);
  expect(b.level).toBe(0);
});

test('keep-placing eight medium curves by clicking in place closes a circle', () => {
  place('curve-m-45');
  for (let i = 0; i < 8; i++) click({ x: 40, y: 40 });
  expect(app.doc.layout.pieces).toHaveLength(8);
  expect(app.doc.graph.open).toHaveLength(0);
});

test('placed switches default to manual mode, state 0', () => {
  place('switch');
  click({ x: 0, y: 0 });
  expect(app.doc.layout.pieces[0].switch).toEqual({ mode: 'manual', state: 0 });
});

test('Tab cycles attachIndex; R flips; Esc returns to select', () => {
  place('curve-m-45');
  key('Tab');
  expect(app.input.mode).toMatchObject({ kind: 'place', attachIndex: 1 });
  key('Tab');
  expect(app.input.mode).toMatchObject({ kind: 'place', attachIndex: 0 });
  key('r');
  expect(app.input.mode).toMatchObject({ kind: 'place', flipped: true });
  key('Escape');
  expect(app.input.mode.kind).toBe('select');
});

test('R steps freeRot for a non-flippable piece; right-click returns to select', () => {
  place('straight-1');
  key('r');
  expect(app.input.mode).toMatchObject({ kind: 'place', freeRot: 22.5, flipped: false });
  canvas.dispatchEvent(pointer('pointerdown', { x: 10, y: 10 }, { button: 2, buttons: 2 }));
  expect(app.input.mode.kind).toBe('select');
  expect(app.doc.layout.pieces).toHaveLength(0);
});

test('Delete removes selection in one undo step', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  click({ x: 0, y: 0 });
  key('Escape');
  const [a, b] = app.doc.layout.pieces.map((p) => p.id);
  click(onPiece(a));
  click(onPiece(b), { shiftKey: true });
  expect([...app.selection].sort()).toEqual([a, b].sort());
  key('Delete');
  expect(app.doc.layout.pieces).toHaveLength(0);
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(2);
});

test('box select on empty space selects the pieces inside; Backspace deletes them', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  key('Escape');
  drag({ x: -200, y: -200 }, { x: 200, y: 200 });
  expect(app.selection.size).toBe(1);
  key('Backspace');
  expect(app.doc.layout.pieces).toHaveLength(0);
});

test('double-click selects the whole connected section', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  click({ x: 0, y: 0 });
  click({ x: 0, y: 0 });
  key('Escape');
  const ids = app.doc.layout.pieces.map((p) => p.id);
  canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: onPiece(ids[0]).x, clientY: onPiece(ids[0]).y, bubbles: true }));
  expect([...app.selection].sort()).toEqual([...ids].sort());
});

test('dragging the selection moves it as one undo step', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  key('Escape');
  const p = app.doc.layout.pieces[0];
  const from = onPiece(p.id);
  drag(from, { x: from.x + 3 * app.camera.zoom, y: from.y });
  expect(app.doc.piece(p.id)!.x).toBeCloseTo(3);
  key('z', { ctrlKey: true });
  expect(app.doc.piece(p.id)!.x).toBeCloseTo(0);
  expect(app.doc.layout.pieces).toHaveLength(1);
});

test('Q and E rotate the selection by -/+22.5 degrees', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  key('Escape');
  const id = app.doc.layout.pieces[0].id;
  click(onPiece(id));
  key('e');
  expect(app.doc.piece(id)!.rot).toBeCloseTo(22.5);
  key('q');
  key('q');
  expect(app.doc.piece(id)!.rot).toBeCloseTo(-22.5);
});

test('clicking a switch toggles it and does not add to history', () => {
  place('switch');
  click({ x: 0, y: 0 });
  key('Escape');
  const id = app.doc.layout.pieces[0].id;
  const exec = vi.spyOn(app.history, 'exec');
  click(onPiece(id));
  expect(app.doc.piece(id)!.switch!.state).toBe(1);
  expect(app.selection.size).toBe(0);
  expect(exec).not.toHaveBeenCalled();
  // undo removes the placement: the toggle was never a history step
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(app.history.canUndo).toBe(false);
});

test('Shift-click on a switch selects it instead of toggling', () => {
  place('switch');
  click({ x: 0, y: 0 });
  key('Escape');
  const id = app.doc.layout.pieces[0].id;
  click(onPiece(id), { shiftKey: true });
  expect(app.doc.piece(id)!.switch!.state).toBe(0);
  expect([...app.selection]).toEqual([id]);
});

test('placeTrain: refused off an open end, placed when there is room; Tab flips direction', () => {
  place('straight-2');
  click({ x: 0, y: 0 });
  const id = app.doc.layout.pieces[0].id;
  app.input.mode = { kind: 'placeTrain', cars: 0, dir: 1 };
  click(onPiece(id, 0, 0.1)); // only 0.2U behind the head: a 1U loco does not fit
  expect(app.doc.layout.trains).toHaveLength(0);
  key('Tab');
  expect(app.input.mode).toMatchObject({ kind: 'placeTrain', dir: -1 });
  click(onPiece(id, 0, 0.1)); // facing backwards: 1.8U behind it
  expect(app.doc.layout.trains).toHaveLength(1);
  const t = app.doc.layout.trains[0];
  expect(t).toMatchObject({ cars: 0, speed: 1.5, running: false, head: { pieceId: id, dir: -1 } });
  expect(t.head!.dist).toBeCloseTo(0.2, 1);
  key('z', { ctrlKey: true });
  expect(app.doc.layout.trains).toHaveLength(0);
});

test('deleting a piece under a train lifts the train in the same undo step', () => {
  place('straight-2');
  click({ x: 0, y: 0 });
  const id = app.doc.layout.pieces[0].id;
  app.input.mode = { kind: 'placeTrain', cars: 0, dir: 1 };
  click(onPiece(id, 0, 0.9));
  expect(app.doc.layout.trains).toHaveLength(1);
  click(onPiece(id, 0, 0.1)); // select mode again: select the piece
  key('Delete');
  expect(app.doc.layout.trains[0].head).toBeNull();
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(1);
  expect(app.doc.layout.trains[0].head).not.toBeNull();
});

test('wheel zooms at the cursor in select mode and flips a flippable piece while placing', () => {
  const z = app.camera.zoom;
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  expect(app.camera.zoom).toBeGreaterThan(z);
  place('curve-m-45');
  const z2 = app.camera.zoom;
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  expect(app.camera.zoom).toBe(z2);
  expect(app.input.mode).toMatchObject({ flipped: true });
});

test('middle-drag pans the view', () => {
  const cx = app.camera.cx;
  drag({ x: 100, y: 100 }, { x: 180, y: 100 }, { button: 1, buttons: 4 });
  expect(app.camera.cx).toBeCloseTo(cx - 80 / app.camera.zoom);
});

test('autosave is debounced 500 ms after an edit', () => {
  vi.useFakeTimers();
  place('straight-1');
  click({ x: 0, y: 0 });
  expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
  vi.advanceTimersByTime(499);
  expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
  vi.advanceTimersByTime(1);
  expect(JSON.parse(localStorage.getItem(AUTOSAVE_KEY)!).pieces).toHaveLength(1);
});

test('toolbar Undo/Redo buttons follow history state', () => {
  const undo = document.querySelector<HTMLButtonElement>('button[data-action="undo"]')!;
  const redo = document.querySelector<HTMLButtonElement>('button[data-action="redo"]')!;
  expect(undo.disabled).toBe(true);
  place('straight-1');
  click({ x: 0, y: 0 });
  expect(undo.disabled).toBe(false);
  undo.click();
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(redo.disabled).toBe(false);
});

test('palette thumbnail click enters place mode', () => {
  const thumb = document.querySelector<HTMLElement>('[data-piece="curve-l-45"]')!;
  thumb.click();
  expect(app.input.mode).toMatchObject({ kind: 'place', type: 'curve-l-45' });
  document.querySelector<HTMLElement>('[data-action="train"]')!.click();
  expect(app.input.mode.kind).toBe('placeTrain');
});

test('Open with a bad file alerts and keeps the layout', () => {
  place('straight-1');
  click({ x: 0, y: 0 });
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  app.openText('{"format":"nope"}');
  expect(alert).toHaveBeenCalledTimes(1);
  expect(app.doc.layout.pieces).toHaveLength(1);
});

test('the animation loop survives a throwing frame (logs and keeps going)', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(app.sim, 'step').mockImplementation(() => { throw new Error('Unknown piece'); });
  app.start();
  frames.shift()!(0);
  expect(() => frames.shift()!(16)).not.toThrow();
  expect(err).toHaveBeenCalled();
  expect(frames).toHaveLength(1);
  app.dispose();
  vi.unstubAllGlobals();
});

test('New asks before discarding a restored layout (no history), and not for an empty one', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  app.newLayout();
  expect(confirm).not.toHaveBeenCalled();
  const layout = app.doc.layout;
  app.loadLayout({ ...layout, pieces: [{ id: 'p1', type: 'straight-1', x: 0, y: 0, rot: 0, level: 0, flipped: false }] });
  expect(app.history.canUndo).toBe(false);
  app.newLayout();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(app.doc.layout.pieces).toHaveLength(1);
  confirm.mockReturnValue(true);
  app.newLayout();
  expect(app.doc.layout.pieces).toHaveLength(0);
});

test('undo/redo clear the keep-placing pin (no ghost stuck on a removed piece)', () => {
  place('curve-m-45');
  click({ x: 40, y: 40 });
  expect(app.input.mode).toMatchObject({ kind: 'place', prefer: expect.anything() });
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect((app.input.mode as { prefer?: unknown }).prefer).toBeUndefined();
  // The next click places a fresh piece at the cursor, not at the removed piece's end.
  click({ x: 40, y: 40 });
  click({ x: 40, y: 40 });
  expect(app.doc.layout.pieces).toHaveLength(2);
  app.undo();
  expect(app.doc.layout.pieces).toHaveLength(1);
  app.input.mode = { ...(app.input.mode as Extract<typeof app.input.mode, { kind: 'place' }>), prefer: app.doc.graph.open[0] };
  expect((app.input.mode as { prefer?: unknown }).prefer).toBeDefined();
  app.redo();
  expect(app.doc.layout.pieces).toHaveLength(2);
  expect((app.input.mode as { prefer?: unknown }).prefer).toBeUndefined();
});

const keyEvent = (k: string, target: EventTarget): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

test('Tab is only intercepted while placing; Space only on the canvas or body', () => {
  const btn = document.createElement('button');
  document.body.append(btn);
  expect(keyEvent('Tab', document.body).defaultPrevented).toBe(false);
  expect(keyEvent(' ', btn).defaultPrevented).toBe(false);
  expect(keyEvent(' ', document.body).defaultPrevented).toBe(true);
  expect(keyEvent(' ', canvas).defaultPrevented).toBe(true);
  place('curve-m-45');
  expect(keyEvent('Tab', document.body).defaultPrevented).toBe(true);
  app.input.mode = { kind: 'placeTrain', cars: 0, dir: 1 };
  expect(keyEvent('Tab', document.body).defaultPrevented).toBe(true);
});

test('placeTrain ghost is marked invalid where the train would not fit', () => {
  place('straight-2');
  click({ x: 0, y: 0 });
  const id = app.doc.layout.pieces[0].id;
  app.input.mode = { kind: 'placeTrain', cars: 0, dir: 1 };
  canvas.dispatchEvent(pointer('pointermove', onPiece(id, 0, 0.1), { buttons: 0 }));
  expect(app.overlay.ghostTrain).toBeDefined();
  expect(app.overlay.ghostTrainValid).toBe(false);
  canvas.dispatchEvent(pointer('pointermove', onPiece(id, 0, 0.9), { buttons: 0 }));
  expect(app.overlay.ghostTrainValid).toBe(true);
});

test('placing "Flex curve" from the palette gives the piece its default flex params, and the layout round-trips', async () => {
  document.querySelector<HTMLElement>('[data-piece="flex-curve"]')!.click();
  click({ x: 40, y: 40 });
  expect(app.doc.layout.pieces).toHaveLength(1);
  expect(app.doc.layout.pieces[0].flex).toEqual({ radius: R_M, sweep: 22.5 });
  const { serialize, deserialize } = await import('../../src/io/serialize');
  const r = deserialize(serialize(app.doc.layout));
  expect(r.ok).toBe(true);
});

/** Two straight-1 runs meeting in a near miss at x = 2: 0.03 sideways and 1° off. */
function nearMissLayout(): void {
  const pieces: Piece[] = [];
  let at: Pose = { x: 0, y: 0, rot: 0 };
  for (const id of ['a1', 'a2']) { const s = attachSpec('straight-1', false, undefined, at, 0); pieces.push(specToPiece(s, id)); at = outPose(s, 1); }
  at = { x: 2, y: 0.03, rot: 1 };
  for (const id of ['b1', 'b2']) { const s = attachSpec('straight-1', false, undefined, at, 0); pieces.push(specToPiece(s, id)); at = outPose(s, 1); }
  app.loadLayout({ ...emptyLayout(), pieces });
}

const ringAt = (): Vec2 => {
  const [a, b] = app.doc.graph.nearMisses[0];
  return worldToScreen(app.camera, app.viewSize(), { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 });
};

test('clicking a near-miss ring closes the gap as one history entry (not a selection)', () => {
  nearMissLayout();
  const before = structuredClone(app.doc.layout.pieces);
  expect(app.doc.graph.nearMisses).toHaveLength(1);
  click(ringAt());
  expect(app.doc.graph.nearMisses).toEqual([]);
  expect(app.doc.layout.pieces.some((p) => p.type.startsWith('flex-'))).toBe(true);
  expect(app.selection.size).toBe(0);
  key('z', { ctrlKey: true });
  expect(app.doc.layout.pieces).toEqual(before);
  expect(app.history.canUndo).toBe(false);
});

test('a near-miss ring that cannot be closed flashes red for 400 ms and changes nothing', () => {
  vi.useFakeTimers();
  const s1 = specToPiece(attachSpec('switch', false, undefined, { x: 0, y: 0, rot: 180 }, 0), 's1');
  const e = outPose(s1, 1);
  const s2 = specToPiece(attachSpec('switch', false, undefined, { x: e.x, y: e.y + 0.03, rot: e.rot + 1 }, 0, 1), 's2');
  for (const s of [s1, s2]) s.switch = { mode: 'manual', state: 0 };
  app.loadLayout({ ...emptyLayout(), pieces: [s1, s2] });
  const before = structuredClone(app.doc.layout.pieces);
  const ring = app.doc.graph.nearMisses[0];
  click(ringAt());
  expect(app.doc.layout.pieces).toEqual(before);
  expect(app.history.canUndo).toBe(false);
  expect(app.flashRing).toEqual({ x: (ring[0].pos.x + ring[1].pos.x) / 2, y: (ring[0].pos.y + ring[1].pos.y) / 2 });
  vi.advanceTimersByTime(399);
  expect(app.flashRing).toBeDefined();
  vi.advanceTimersByTime(1);
  expect(app.flashRing).toBeUndefined();
});

function flexAt(): Piece {
  const p: Piece = { id: 'f1', type: 'flex-straight', x: 0, y: 0, rot: 0, level: 0, flipped: false, flex: { length: 1 } };
  app.loadLayout({ ...emptyLayout(), pieces: [p] });
  app.selection = new Set(['f1']);
  return p;
}
const toScreen = (w: Vec2): Vec2 => worldToScreen(app.camera, app.viewSize(), w);

test('dragging a selected flex piece\'s end handle resizes it as one undoable step', () => {
  flexAt();
  const from = toScreen({ x: 1, y: 0 }), to = toScreen({ x: 2.5, y: 0.2 });
  drag(from, to);
  expect(app.doc.piece('f1')!.flex).toEqual({ length: 2.5 });
  expect(app.selection.has('f1')).toBe(true);
  expect(app.preview).toBeNull();
  key('z', { ctrlKey: true });
  expect(app.doc.piece('f1')!.flex).toEqual({ length: 1 });
  expect(app.history.canUndo).toBe(false);
});

test('dragging the start handle moves the piece and keeps its far end', () => {
  flexAt();
  drag(toScreen({ x: 0, y: 0 }), toScreen({ x: -0.5, y: 0 }));
  const p = app.doc.piece('f1')!;
  expect(p.flex).toEqual({ length: 1.5 });
  expect(p.x).toBeCloseTo(-0.5, 6);
});

test('a handle press without movement issues no command; an unselected flex piece has no handles', () => {
  flexAt();
  click(toScreen({ x: 1, y: 0 }));
  expect(app.history.canUndo).toBe(false);
  app.selection = new Set();
  drag(toScreen({ x: 1, y: 0 }), toScreen({ x: 2.5, y: 0 }));
  expect(app.doc.piece('f1')!.flex).toEqual({ length: 1 });
});

test('jitter on a flex handle (within DRAG_PX) is not a resize: no history entry', () => {
  flexAt();
  const from = toScreen({ x: 1, y: 0 });
  drag(from, { x: from.x + 3, y: from.y });
  expect(app.doc.piece('f1')!.flex).toEqual({ length: 1 });
  expect(app.history.canUndo).toBe(false);
});

test('a click on a flex handle sitting on a near-miss ring closes the gap', () => {
  nearMissLayout();
  const a2 = app.doc.piece('a2')!;
  app.loadLayout({ ...app.doc.layout, pieces: app.doc.layout.pieces.map((p) => (p.id === 'a2' ? { ...a2, type: 'flex-straight', flex: { length: 1 } } : p)) });
  app.selection = new Set(['a2']);
  expect(app.doc.graph.nearMisses).toHaveLength(1);
  click(ringAt());
  expect(app.doc.graph.nearMisses).toEqual([]);
  expect(app.history.canUndo).toBe(true);
});
