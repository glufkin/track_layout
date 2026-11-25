// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../../src/ui/app';
import { type Vec2, dist } from '../../src/geom/vec';
import { samplePath } from '../../src/geom/path';
import { attachSpec, specToPiece } from '../../src/sketch/spec';
import { worldConnectors, worldRoutePath } from '../../src/track/graph';
import { worldToScreen } from '../../src/render/camera';
import type { Clicker } from '../../src/ui/sound';

let app: App;
let canvas: HTMLCanvasElement;
let sounds: { tick: number; settle: number; bonk: number };

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root);
  canvas = app.canvas;
  sounds = { tick: 0, settle: 0, bonk: 0 };
  app.clicker = {
    enabled: true, unlock() {}, setEnabled() {},
    tick() { sounds.tick++; }, settle() { sounds.settle++; }, bonk() { sounds.bonk++; },
  } as unknown as Clicker;
});

afterEach(() => { app.dispose(); vi.restoreAllMocks(); });

/** Screen point of a world point (jsdom's canvas is 0×0, so this is world × zoom). */
const scr = (w: Vec2): Vec2 => worldToScreen(app.camera, app.viewSize(), w);

const pointer = (type: string, at: Vec2, o: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { clientX: at.x, clientY: at.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, ...o });

const key = (k: string, o: KeyboardEventInit = {}, target: EventTarget = window): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
};

/** World points every 0.1U along the polyline through `corners` (excluding the first). */
function polyline(corners: Vec2[], step = 0.1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i], b = corners[i + 1];
    const n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

const down = (w: Vec2, o: PointerEventInit = {}): void => { canvas.dispatchEvent(pointer('pointerdown', scr(w), o)); };
const moveThrough = (corners: Vec2[], o: PointerEventInit = {}): void => {
  for (const p of polyline(corners)) canvas.dispatchEvent(pointer('pointermove', scr(p), o));
};
const up = (w: Vec2, o: PointerEventInit = {}): void => { canvas.dispatchEvent(pointer('pointerup', scr(w), o)); };

function stroke(corners: Vec2[], o: PointerEventInit = {}): void {
  down(corners[0], o);
  moveThrough(corners, o);
  up(corners[corners.length - 1], o);
}

const near45 = (deg: number): boolean => Math.abs(deg / 45 - Math.round(deg / 45)) < 1e-6;

test('S enters sketch mode and Esc leaves it; the toolbar Sketch button toggles it', () => {
  key('s');
  expect(app.input.mode.kind).toBe('sketch');
  expect(canvas.classList.contains('tl-sketch')).toBe(true);
  key('Escape');
  expect(app.input.mode.kind).toBe('select');
  expect(canvas.classList.contains('tl-sketch')).toBe(false);
  key('S', { shiftKey: true });
  expect(app.input.mode.kind).toBe('sketch');
  const btn = document.querySelector<HTMLButtonElement>('[data-action="sketch"]')!;
  expect(btn.getAttribute('aria-pressed')).toBe('true');
  btn.click();
  expect(app.input.mode.kind).toBe('select');
  expect(btn.getAttribute('aria-pressed')).toBe('false');
  btn.click();
  expect(app.input.mode.kind).toBe('sketch');
});

test('a 4U drag east from an empty table commits once, with buffers at both ends', () => {
  key('s');
  stroke([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  const pieces = app.doc.layout.pieces;
  expect(pieces.filter((p) => p.type === 'buffer')).toHaveLength(2);
  expect(pieces.filter((p) => p.type !== 'buffer').length).toBeGreaterThan(0);
  expect(app.doc.graph.open).toEqual([]);
  expect(app.input.mode.kind).toBe('sketch');
  app.undo();
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(app.history.canUndo).toBe(false);
});

test('one tick per appended ghost piece and one settle on commit', () => {
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  const ghost = app.input.sketch.overlay()!.ghost.length;
  expect(ghost).toBeGreaterThan(0);
  expect(sounds.tick).toBe(ghost);
  expect(sounds.settle).toBe(0);
  up({ x: 4, y: 0 });
  expect(sounds.settle).toBe(1);
  expect(app.doc.layout.pieces.length).toBeGreaterThan(0);
});

test('Esc mid-drag cancels the stroke but stays in sketch mode', () => {
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  expect(app.overlay.sketch?.ghost.length).toBeGreaterThan(0);
  key('Escape');
  expect(app.overlay.sketch).toBeUndefined();
  up({ x: 4, y: 0 });
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(app.history.canUndo).toBe(false);
  expect(app.input.mode.kind).toBe('sketch');
  expect(sounds.settle).toBe(0);
});

test('+ mid-drag lays a ramp and later pieces are at level 1', () => {
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  key('+', { shiftKey: true });
  expect(app.input.sketch.overlay()!.pendingRamp).toBe(1);
  moveThrough([{ x: 1, y: 0 }, { x: 8, y: 0 }]);
  up({ x: 8, y: 0 });
  const pieces = app.doc.layout.pieces;
  const ramp = pieces.find((p) => p.type === 'ramp-2');
  expect(ramp).toBeDefined();
  const after = pieces.filter((p) => p.x > ramp!.x + 2.5);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((p) => p.level === 1)).toBe(true);
});

test('= also requests a ramp; an out-of-range - bonks', () => {
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  key('-');
  expect(sounds.bonk).toBe(1);
  expect(app.input.sketch.overlay()!.pendingRamp).toBe(0);
  key('=');
  expect(app.input.sketch.overlay()!.pendingRamp).toBe(1);
  key('_');
  expect(app.input.sketch.overlay()!.pendingRamp).toBe(0);
  expect(sounds.bonk).toBe(1);
});

test('Shift held lays only pieces on 45° headings', () => {
  key('s');
  const path = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2 + 3 * Math.cos(Math.PI / 6), y: 3 * Math.sin(Math.PI / 6) }];
  stroke(path, { shiftKey: true });
  const pieces = app.doc.layout.pieces;
  expect(pieces.length).toBeGreaterThan(2);
  for (const p of pieces) for (const c of worldConnectors(p)) expect(near45(c.heading)).toBe(true);
});

test('without Shift the same stroke uses 22.5° headings', () => {
  key('s');
  const path = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2 + 3 * Math.cos(Math.PI / 6), y: 3 * Math.sin(Math.PI / 6) }];
  stroke(path);
  const heads = app.doc.layout.pieces.flatMap((p) => worldConnectors(p).map((c) => c.heading));
  expect(heads.some((h) => !near45(h))).toBe(true);
});

test('a drag starting on a curve with no straight nearby commits nothing and shows refusedAt', () => {
  const curve = specToPiece(attachSpec('curve-l-45', false, undefined, { x: 0, y: 0, rot: 0 }, 0), 'c1');
  app.doc.layout.pieces.push(curve);
  app.doc.rebuild();
  const path = worldRoutePath(curve, 0);
  const mid = samplePath(path, path.length / 2).pos;
  key('s');
  down(mid);
  expect(canvas.classList.contains('tl-refused')).toBe(true);
  moveThrough([mid, { x: mid.x, y: mid.y - 4 }]);
  up({ x: mid.x, y: mid.y - 4 });
  expect(app.doc.layout.pieces).toHaveLength(1);
  expect(app.history.canUndo).toBe(false);
  const o = app.input.sketch.overlay()!;
  expect(o.refusedAt).toBeDefined();
  expect(dist(o.refusedAt!, mid)).toBeLessThan(1e-9);
  expect(o.ghost).toEqual([]);
  expect(sounds.tick).toBe(0);
  // The next press clears the refusal.
  stroke([{ x: 10, y: 10 }, { x: 14, y: 10 }]);
  expect(canvas.classList.contains('tl-refused')).toBe(false);
  expect(app.input.sketch.overlay()?.refusedAt).toBeUndefined();
});

test('a stroke from the middle of a straight run starts with a switch', () => {
  const run = [0, 1, 2, 3].map((i) => specToPiece(attachSpec('straight-1', false, undefined, { x: i, y: 0, rot: 0 }, 0), 's' + i));
  app.doc.layout.pieces.push(...run);
  app.doc.rebuild();
  key('s');
  down({ x: 2, y: 0 });
  // Provisional until the pointer moves away: no switch yet.
  expect(app.input.sketch.overlay()?.switchPreview ?? []).toEqual([]);
  moveThrough([{ x: 2, y: 0 }, { x: 3, y: 1 }, { x: 4, y: 4 }]);
  expect(app.input.sketch.overlay()!.switchPreview!.map((p) => p.type)).toEqual(['switch']);
  up({ x: 4, y: 4 });
  expect(app.doc.layout.pieces.filter((p) => p.type === 'switch')).toHaveLength(1);
});

test('sketch keys typed into a text input do nothing', () => {
  const input = document.createElement('input');
  document.body.append(input);
  key('s', {}, input);
  expect(app.input.mode.kind).toBe('select');
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  key('+', {}, input);
  key('=', {}, input);
  key('-', {}, input);
  expect(app.input.sketch.overlay()!.pendingRamp).toBe(0);
  expect(sounds.bonk).toBe(0);
  key('Escape', {}, input);
  expect(app.input.mode.kind).toBe('sketch');
  moveThrough([{ x: 1, y: 0 }, { x: 4, y: 0 }]);
  up({ x: 4, y: 0 });
  expect(app.doc.layout.pieces.length).toBeGreaterThan(0);
});

test('middle-button drag pans in sketch mode without drawing; the wheel zooms', () => {
  key('s');
  const cam = { ...app.camera };
  canvas.dispatchEvent(pointer('pointerdown', { x: 0, y: 0 }, { button: 1, buttons: 4 }));
  canvas.dispatchEvent(pointer('pointermove', { x: 80, y: 0 }, { buttons: 4 }));
  canvas.dispatchEvent(pointer('pointerup', { x: 80, y: 0 }, { button: 1 }));
  expect(app.camera.cx).toBeCloseTo(cam.cx - 1);
  expect(app.doc.layout.pieces).toHaveLength(0);
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  expect(app.camera.zoom).toBeGreaterThan(cam.zoom);
  expect(app.input.mode.kind).toBe('sketch');
});

test('a middle-button pan pressed mid-stroke cancels the stroke first', () => {
  key('s');
  down({ x: 0, y: 0 });
  moveThrough([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  expect(app.overlay.sketch?.ghost.length).toBeGreaterThan(0);
  const cam = { ...app.camera };
  canvas.dispatchEvent(pointer('pointerdown', scr({ x: 4, y: 0 }), { button: 1, buttons: 5 }));
  expect(app.overlay.sketch).toBeUndefined();
  canvas.dispatchEvent(pointer('pointermove', { x: scr({ x: 4, y: 0 }).x + 80, y: scr({ x: 4, y: 0 }).y }, { buttons: 5 }));
  expect(app.camera.cx).toBeCloseTo(cam.cx - 1);
  canvas.dispatchEvent(pointer('pointerup', scr({ x: 5, y: 0 }), { button: 1 }));
  up({ x: 5, y: 0 });
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(app.history.canUndo).toBe(false);
  expect(sounds.settle).toBe(0);
});

test('the Sound toggle mutes and unmutes the clicker', () => {
  const btn = document.querySelector<HTMLButtonElement>('[data-action="sound"]')!;
  let on = true;
  app.clicker = { get enabled() { return on; }, setEnabled(v: boolean) { on = v; } } as unknown as Clicker;
  app.notify();
  expect(btn.getAttribute('aria-pressed')).toBe('true');
  btn.click();
  expect(on).toBe(false);
  expect(btn.getAttribute('aria-pressed')).toBe('false');
});

test('Ctrl-Z mid-stroke drops the stroke and undoes the previous edit', () => {
  key('s');
  stroke([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  const n = app.doc.layout.pieces.length;
  expect(n).toBeGreaterThan(0);
  down({ x: 0, y: 3 });
  moveThrough([{ x: 0, y: 3 }, { x: 4, y: 3 }]);
  key('z', { ctrlKey: true });
  up({ x: 4, y: 3 });
  expect(app.doc.layout.pieces).toHaveLength(0);
  expect(app.history.canUndo).toBe(false);
});
