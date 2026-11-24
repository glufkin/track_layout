import { test, expect } from 'vitest';
import { History } from '../../src/editor/history';
import { placePieces, transformPieces, deletePieces, setSwitchMode, batch } from '../../src/editor/commands';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece } from '../../src/model/types';

const P = (id: string, type: string, x: number, y: number, rot = 0): Piece =>
  ({ id, type, x, y, rot, level: 0, flipped: false });

test('exec/undo/redo place', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(placePieces([P('a', 'straight-1', 0, 0)]), d);
  expect(d.layout.pieces).toHaveLength(1);
  h.undo(d); expect(d.layout.pieces).toHaveLength(0);
  h.redo(d); expect(d.layout.pieces).toHaveLength(1);
});
test('place snapshots input (later mutation does not corrupt history)', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  const p = P('a', 'straight-1', 0, 0);
  h.exec(placePieces([p]), d);
  h.undo(d); h.redo(d);
  d.layout.pieces[0].x = 9;
  h.undo(d); h.redo(d);
  expect(d.layout.pieces[0].x).toBe(0);
});
test('transformPieces moves a group in one undo step', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(placePieces([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0), P('c', 'straight-1', 2, 0)]), d);
  const next = new Map([['a', { x: 0, y: 5, rot: 0 }], ['b', { x: 1, y: 5, rot: 90, flipped: true }], ['c', { x: 2, y: 5, rot: 0 }]]);
  h.exec(transformPieces(['a', 'b', 'c'], next), d);
  expect(d.piece('b')).toMatchObject({ y: 5, rot: 90, flipped: true });
  expect(d.piece('a')!.flipped).toBe(false);
  h.undo(d);
  expect(d.layout.pieces.map((p) => [p.y, p.rot, p.flipped])).toEqual([[0, 0, false], [0, 0, false], [0, 0, false]]);
  h.redo(d);
  expect(d.piece('c')!.y).toBe(5);
});
test('deletePieces undo restores ids, order and switch settings', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  const sw: Piece = { ...P('b', 'straight-1', 1, 0), switch: { mode: 'auto', state: 1 } };
  h.exec(placePieces([P('a', 'straight-1', 0, 0), sw, P('c', 'straight-1', 2, 0), P('d', 'straight-1', 3, 0)]), d);
  const before = structuredClone(d.layout.pieces);
  h.exec(deletePieces(['b', 'd']), d);
  expect(d.layout.pieces.map((p) => p.id)).toEqual(['a', 'c']);
  h.undo(d);
  expect(d.layout.pieces).toEqual(before);
  h.redo(d);
  expect(d.layout.pieces.map((p) => p.id)).toEqual(['a', 'c']);
});
test('graph is rebuilt after undo (joins reappear)', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(placePieces([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0)]), d);
  expect(d.graph.joins.size).toBe(2);
  h.exec(deletePieces(['b']), d);
  expect(d.graph.joins.size).toBe(0);
  h.undo(d);
  expect(d.graph.joins.size).toBe(2);
});
test('setSwitchMode is undoable', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(placePieces([{ ...P('s', 'straight-1', 0, 0), switch: { mode: 'manual', state: 0 } }]), d);
  h.exec(setSwitchMode('s', 'auto'), d);
  expect(d.piece('s')!.switch!.mode).toBe('auto');
  h.undo(d);
  expect(d.piece('s')!.switch!.mode).toBe('manual');
});
test('batch undoes in reverse as one step', () => {
  const d = new Doc(emptyLayout()); const h = new History();
  h.exec(batch('two', [placePieces([P('a', 'straight-1', 0, 0)]), placePieces([P('b', 'straight-1', 1, 0)])]), d);
  expect(d.layout.pieces).toHaveLength(2);
  h.undo(d);
  expect(d.layout.pieces).toHaveLength(0);
  expect(h.canUndo).toBe(false);
});
