import { test, expect } from 'vitest';
import { History } from '../../src/editor/history';
import {
  placeTrain, moveTrain, deleteTrains, setTrainProps, canPlaceTrain, withLifting,
  deletePieces, transformPieces,
} from '../../src/editor/commands';
import { Doc } from '../../src/model/doc';
import { emptyLayout, type Piece, type Train, type TrackPos } from '../../src/model/types';
import { carPoses } from '../../src/sim/motion';

const P = (id: string, type: string, x: number, y: number, rot = 0): Piece =>
  ({ id, type, x, y, rot, level: 0, flipped: false });
const T = (pieceId: string, dist: number, dir: 1 | -1 = 1, route = 0): TrackPos => ({ pieceId, route, dist, dir });
const train = (id: string, head: TrackPos | null, o: Partial<Train> = {}): Train => ({
  id, cars: 0, color: '#c00', speed: 1, running: true, head, lifted: null,
  currentSpeed: 0.5, crashed: false, crashAt: null, ...o,
});
/** Five straight-2 pieces end to end along +x: s0 spans x 0..2, s4 spans x 8..10. */
const line = (): Piece[] => [0, 1, 2, 3, 4].map((i) => P('s' + i, 'straight-2', 2 * i, 0));
const doc = (trains: Train[]): Doc => new Doc({ ...emptyLayout(), pieces: line(), trains });

test('placeTrain refused (canPlaceTrain false) when the train would hang off an end', () => {
  const d = doc([]);
  // 1 car: length 1.9; head 1.0 from the open end at x=0 would hang off.
  expect(canPlaceTrain(d, T('s0', 1), 1)).toBe(false);
  expect(canPlaceTrain(d, T('s0', 1), 0)).toBe(true);
  expect(canPlaceTrain(d, T('s1', 0), 1)).toBe(true);
  // Facing the other way, the tail extends toward x=10.
  expect(canPlaceTrain(d, T('s4', 1, -1), 1)).toBe(false);
  expect(canPlaceTrain(d, T('s3', 1, -1), 1)).toBe(true);
  // Unknown piece or route.
  expect(canPlaceTrain(d, T('nope', 1), 0)).toBe(false);
  expect(canPlaceTrain(d, T('s1', 1, 1, 7), 0)).toBe(false);

  const h = new History();
  h.exec(placeTrain(train('a', T('s2', 1))), d);
  expect(d.layout.trains.map((t) => t.id)).toEqual(['a']);
  h.undo(d); expect(d.layout.trains).toHaveLength(0);
  h.redo(d); expect(d.train('a')?.head).toEqual(T('s2', 1));
});

test('deleting a piece under a train lifts it, not deletes it', () => {
  const a = train('a', T('s1', 1.5));
  const d = doc([a]);
  const loco = carPoses(d, a)[0];
  const h = new History();
  h.exec(withLifting(d, ['s1'], deletePieces(['s1'])), d);
  expect(d.layout.trains).toHaveLength(1);
  const t = d.train('a')!;
  expect(t.head).toBeNull();
  expect(t.lifted).toEqual({ x: loco.center.x, y: loco.center.y, rot: loco.heading });
  expect(t.running).toBe(false);
  expect(t.currentSpeed).toBe(0);
  expect(d.piece('s1')).toBeUndefined();
});

test('moving a piece under a train lifts it; untouched trains keep running', () => {
  const a = train('a', T('s1', 1.5));
  // b's loco spans x 9.5..8.5, entirely on s4.
  const b = train('b', T('s4', 1.5));
  const d = doc([a, b]);
  const h = new History();
  // a's loco spans x 2.5..3.5, entirely on s1.
  const next = new Map([['s1', { x: 2, y: 5, rot: 0 }]]);
  h.exec(withLifting(d, ['s1'], transformPieces(['s1'], next)), d);
  expect(d.train('a')!.head).toBeNull();
  expect(d.train('a')!.running).toBe(false);
  expect(d.train('b')!.head).toEqual(T('s4', 1.5));
  expect(d.train('b')!.running).toBe(true);
  expect(d.train('b')!.currentSpeed).toBe(0.5);
  expect(d.piece('s1')!.y).toBe(5);
});

test('a train partly on an edited piece is lifted too', () => {
  // head 0.3 into s2: loco spans back onto s1.
  const a = train('a', T('s2', 0.3));
  const d = doc([a]);
  new History().exec(withLifting(d, ['s1'], deletePieces(['s1'])), d);
  expect(d.train('a')!.head).toBeNull();
});

test('undo restores a lifted train in place, stopped', () => {
  const a = train('a', T('s1', 1.5), { crashed: true, crashAt: { x: 1, y: 1 } });
  const d = doc([a]);
  const h = new History();
  h.exec(withLifting(d, ['s1'], deletePieces(['s1'])), d);
  expect(d.train('a')!.head).toBeNull();
  h.undo(d);
  const t = d.train('a')!;
  expect(d.piece('s1')).toBeDefined();
  expect(t.head).toEqual(T('s1', 1.5));
  expect(t.running).toBe(false);
  expect(t.currentSpeed).toBe(0);
  expect(t.crashed).toBe(false);
  expect(t.crashAt).toBeNull();
  expect(t.lifted).toBeNull();
  // Redo lifts it again.
  h.redo(d);
  expect(d.train('a')!.head).toBeNull();
  expect(d.train('a')!.lifted).not.toBeNull();
});

test('undo leaves the train lifted if another train now occupies its spot', () => {
  const a = train('a', T('s1', 1.5));
  const d = doc([a]);
  const h = new History();
  h.exec(withLifting(d, ['s1'], deletePieces(['s1'])), d);
  const liftedPose = d.train('a')!.lifted;
  // Another train is placed where a would land once s1 is restored.
  d.layout.trains.push(train('b', T('s1', 1.2), { running: true }));
  h.undo(d);
  expect(d.train('a')!.head).toBeNull();
  expect(d.train('a')!.lifted).toEqual(liftedPose);
  // b is untouched.
  expect(d.train('b')!.running).toBe(true);
});

test('undo leaves alone a lifted train that was re-placed meanwhile', () => {
  const a = train('a', T('s1', 1.5));
  const d = doc([a]);
  const h = new History();
  h.exec(withLifting(d, ['s1'], deletePieces(['s1'])), d);
  // User drops the lifted train elsewhere (not through history here).
  const t = d.train('a')!;
  t.head = T('s3', 1); t.lifted = null; t.running = true;
  h.undo(d);
  expect(d.train('a')!.head).toEqual(T('s3', 1));
  expect(d.train('a')!.running).toBe(true);
});

test('setTrainProps cars/color undoable', () => {
  const d = doc([train('a', T('s2', 1), { cars: 2, color: '#c00' })]);
  const h = new History();
  h.exec(setTrainProps('a', { cars: 5, color: '#00f' }), d);
  expect(d.train('a')!.cars).toBe(5);
  expect(d.train('a')!.color).toBe('#00f');
  h.undo(d);
  expect(d.train('a')!.cars).toBe(2);
  expect(d.train('a')!.color).toBe('#c00');
  h.redo(d);
  expect(d.train('a')!.cars).toBe(5);
  h.undo(d);
  h.exec(setTrainProps('a', { color: '#0f0' }), d);
  expect(d.train('a')!.cars).toBe(2);
  expect(d.train('a')!.color).toBe('#0f0');
});

test('moveTrain clears crashed', () => {
  const before = train('a', T('s1', 1), { crashed: true, crashAt: { x: 3, y: 0 }, running: true, currentSpeed: 0.7 });
  const d = doc([before]);
  const h = new History();
  h.exec(moveTrain('a', T('s3', 1)), d);
  let t = d.train('a')!;
  expect(t.head).toEqual(T('s3', 1));
  expect(t.crashed).toBe(false);
  expect(t.crashAt).toBeNull();
  expect(t.running).toBe(false);
  expect(t.currentSpeed).toBe(0);
  expect(t.lifted).toBeNull();
  h.undo(d);
  t = d.train('a')!;
  expect(t).toEqual(train('a', T('s1', 1), { crashed: true, crashAt: { x: 3, y: 0 }, running: true, currentSpeed: 0.7 }));
});

test('moveTrain drops a lifted train back onto the track', () => {
  const d = doc([train('a', null, { lifted: { x: 1, y: 1, rot: 0 }, running: false })]);
  const h = new History();
  h.exec(moveTrain('a', T('s2', 1)), d);
  expect(d.train('a')!.head).toEqual(T('s2', 1));
  expect(d.train('a')!.lifted).toBeNull();
  h.undo(d);
  expect(d.train('a')!.head).toBeNull();
  expect(d.train('a')!.lifted).toEqual({ x: 1, y: 1, rot: 0 });
});

test('deleteTrains undo reinserts at original indices', () => {
  const d = doc(['a', 'b', 'c', 'd'].map((id, i) => train(id, T('s' + i, 1))));
  const h = new History();
  h.exec(deleteTrains(['b', 'd']), d);
  expect(d.layout.trains.map((t) => t.id)).toEqual(['a', 'c']);
  h.undo(d);
  expect(d.layout.trains.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  h.redo(d);
  expect(d.layout.trains.map((t) => t.id)).toEqual(['a', 'c']);
});
