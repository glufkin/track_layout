// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../../src/ui/app';
import type { Vec2 } from '../../src/geom/vec';
import { samplePath } from '../../src/geom/path';
import { worldRoutePath } from '../../src/track/graph';
import { worldToScreen } from '../../src/render/camera';
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
