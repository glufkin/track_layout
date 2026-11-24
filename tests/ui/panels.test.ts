// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../../src/ui/app';
import type { Vec2 } from '../../src/geom/vec';
import { samplePath } from '../../src/geom/path';
import { worldRoutePath } from '../../src/track/graph';
import { worldToScreen } from '../../src/render/camera';

let app: App;
let canvas: HTMLCanvasElement;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root);
  canvas = app.canvas;
});

afterEach(() => { app.dispose(); vi.restoreAllMocks(); });

const pointer = (type: string, at: Vec2, o: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { clientX: at.x, clientY: at.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, ...o });

function click(at: Vec2, o: PointerEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointermove', at, { buttons: 0 }));
  canvas.dispatchEvent(pointer('pointerdown', at, o));
  canvas.dispatchEvent(pointer('pointerup', at, o));
}

function onPiece(id: string, route = 0, frac = 0.5): Vec2 {
  const p = app.doc.piece(id)!;
  const path = worldRoutePath(p, route);
  return worldToScreen(app.camera, app.viewSize(), samplePath(path, path.length * frac).pos);
}

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.tl-panel');
const q = <T extends Element>(sel: string): T => panel()!.querySelector<T>(sel)!;

/** A 2U straight with a 0-car train near its far end, selected (its panel open). */
function trainOnStraight(): string {
  app.input.mode = { kind: 'place', type: 'straight-2', flipped: false, attachIndex: 0, freeRot: 0 };
  click({ x: 0, y: 0 });
  const id = app.doc.layout.pieces[0].id;
  app.input.mode = { kind: 'placeTrain', cars: 0, dir: 1 };
  click(onPiece(id, 0, 0.9));
  return app.doc.layout.trains[0].id;
}

function selectedSwitch(): string {
  app.input.mode = { kind: 'place', type: 'switch', flipped: false, attachIndex: 0, freeRot: 0 };
  click({ x: 0, y: 0 });
  app.input.setMode({ kind: 'select' });
  const id = app.doc.layout.pieces[0].id;
  click(onPiece(id), { shiftKey: true });
  return id;
}

test('selecting a train shows its panel; clearing the selection hides it', () => {
  const id = trainOnStraight();
  expect(app.selectedTrain).toBe(id);
  expect(panel()?.dataset.train).toBe(id);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(panel()).toBeNull();
});

test('train panel Run toggles running without a history entry', () => {
  const id = trainOnStraight();
  const exec = vi.spyOn(app.history, 'exec');
  const run = q<HTMLButtonElement>('[data-action="run"]');
  run.click();
  expect(app.doc.train(id)!.running).toBe(true);
  expect(run.textContent).toMatch(/Stop/);
  run.click();
  expect(app.doc.train(id)!.running).toBe(false);
  expect(exec).not.toHaveBeenCalled();
});

test('speed slider and Reverse change the train without history', () => {
  const id = trainOnStraight();
  const exec = vi.spyOn(app.history, 'exec');
  const speed = q<HTMLInputElement>('[data-action="speed"]');
  expect([speed.min, speed.max]).toEqual(['0.2', '4']);
  speed.value = '3';
  speed.dispatchEvent(new Event('input', { bubbles: true }));
  expect(app.doc.train(id)!.speed).toBe(3);
  const dir = app.doc.train(id)!.head!.dir;
  q<HTMLButtonElement>('[data-action="reverse"]').click();
  expect(app.doc.train(id)!.head!.dir).toBe(dir === 1 ? -1 : 1);
  expect(exec).not.toHaveBeenCalled();
});

test('train panel car count and colour are undoable', () => {
  const id = trainOnStraight();
  const cars = q<HTMLInputElement>('[data-action="cars"]');
  cars.value = '25';
  cars.dispatchEvent(new Event('change', { bubbles: true }));
  expect(app.doc.train(id)!.cars).toBe(20);
  const color = q<HTMLInputElement>('[data-action="color"]');
  color.value = '#123456';
  color.dispatchEvent(new Event('change', { bubbles: true }));
  expect(app.doc.train(id)!.color).toBe('#123456');
  app.undo();
  expect(app.doc.train(id)!.color).not.toBe('#123456');
  app.undo();
  expect(app.doc.train(id)!.cars).toBe(0);
  expect(q<HTMLInputElement>('[data-action="cars"]').value).toBe('0');
});

test('train panel Delete removes the train (undoable) and hides the panel', () => {
  const id = trainOnStraight();
  q<HTMLButtonElement>('[data-action="delete"]').click();
  expect(app.doc.layout.trains).toHaveLength(0);
  expect(panel()).toBeNull();
  app.undo();
  expect(app.doc.train(id)).toBeDefined();
});

test('a lifted train shows "Place back", which enters placeTrain mode targeting it', () => {
  const id = trainOnStraight();
  const pieceId = app.doc.layout.pieces[0].id;
  click(onPiece(pieceId, 0, 0.1));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
  expect(app.doc.train(id)!.head).toBeNull();
  app.undo(); // piece back; train restored onto it
  app.doc.train(id)!.head = null;
  app.doc.train(id)!.lifted = { x: 0, y: 0, rot: 0 };
  app.selectedTrain = id;
  app.notify();
  const place = q<HTMLButtonElement>('[data-action="place-back"]');
  expect(place).not.toBeNull();
  place.click();
  expect(app.input.mode).toMatchObject({ kind: 'placeTrain', cars: 0 });
  expect(app.selectedTrain).toBe(id);
  click(onPiece(pieceId, 0, 0.9));
  expect(app.doc.layout.trains).toHaveLength(1);
  expect(app.doc.train(id)!.head).not.toBeNull();
});

test('selecting exactly one switch shows its panel; mode change is undoable', () => {
  const id = selectedSwitch();
  expect(panel()?.dataset.switch).toBe(id);
  const auto = q<HTMLInputElement>('input[value="auto"]');
  expect(q<HTMLInputElement>('input[value="manual"]').checked).toBe(true);
  auto.checked = true;
  auto.dispatchEvent(new Event('change', { bubbles: true }));
  expect(app.doc.piece(id)!.switch!.mode).toBe('auto');
  app.undo();
  expect(app.doc.piece(id)!.switch!.mode).toBe('manual');
  expect(q<HTMLInputElement>('input[value="manual"]').checked).toBe(true);
});

test('no switch panel for a non-switch or a multi-piece selection', () => {
  app.input.mode = { kind: 'place', type: 'straight-1', flipped: false, attachIndex: 0, freeRot: 0 };
  click({ x: 0, y: 0 });
  app.input.setMode({ kind: 'select' });
  click(onPiece(app.doc.layout.pieces[0].id));
  expect(app.selection.size).toBe(1);
  expect(panel()).toBeNull();
});
