import { test, expect } from 'vitest';
import { applyPose, normDeg } from '../../src/geom/vec';
import { Doc } from '../../src/model/doc';
import { type Piece, emptyLayout } from '../../src/model/types';
import { FLEX_LIMITS, R_M, pieceGeometry } from '../../src/track/catalog';
import { worldConnectors } from '../../src/track/graph';
import { flexResize, resizeFlex } from '../../src/sketch/flexResize';

const straight = (x = 0, y = 0, rot = 0): Piece =>
  ({ id: 'f', type: 'flex-straight', x, y, rot, level: 0, flipped: false, flex: { length: 1 } });
const curve = (flipped = false, x = 0, y = 0, rot = 0): Piece =>
  ({ id: 'f', type: 'flex-curve', x, y, rot, level: 0, flipped, flex: { radius: R_M, sweep: 22.5 } });
const apply = (p: Piece, r: ReturnType<typeof flexResize>): Piece => ({ ...p, ...r });
const end = (p: Piece, i: number) => { const c = worldConnectors(p)[i]; return { x: c.pos.x, y: c.pos.y, h: c.heading }; };
const same = (a: { x: number; y: number; h: number }, b: { x: number; y: number; h: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9);
  expect(Math.abs(normDeg(a.h - b.h))).toBeLessThan(1e-7);
};

test('dragging end 1 of a flex straight sets the projected length and keeps end 0', () => {
  const p = straight(1, 2, 30);
  const to = applyPose(p, { x: 2.5, y: 0.3 });
  const r = flexResize(p, 1, to, false);
  expect((r.flex as { length: number }).length).toBeCloseTo(2.5, 9);
  expect([r.x, r.y, r.rot]).toEqual([1, 2, 30]);
});

test('dragging end 0 keeps end 1 fixed (straight and both curve directions)', () => {
  const s = straight(1, 2, 30);
  const rs = flexResize(s, 0, applyPose(s, { x: -0.7, y: 0.2 }), false);
  expect((rs.flex as { length: number }).length).toBeCloseTo(1.7, 9);
  same(end(apply(s, rs), 1), end(s, 1));
  for (const flipped of [false, true]) {
    const c = curve(flipped, 3, -1, 40);
    const to = applyPose(c, { x: -0.2, y: flipped ? 0.3 : -0.3 });
    const r = flexResize(c, 0, to, false);
    expect(r.flex).not.toEqual(c.flex);
    same(end(apply(c, r), 1), end(c, 1));
  }
});

test('curve sweep follows the dragged point and is clamped to (0, 45]', () => {
  const c = curve();
  const g = pieceGeometry({ ...c, flex: { radius: R_M, sweep: 30 } }).connectors[1].pos;
  const r = flexResize(c, 1, g, false);
  expect((r.flex as { sweep: number }).sweep).toBeCloseTo(30, 6);
  expect((r.flex as { radius: number }).radius).toBe(R_M);
  const far = flexResize(c, 1, { x: 0, y: 5 }, false);
  expect((far.flex as { sweep: number }).sweep).toBe(FLEX_LIMITS.maxSweep);
  const back = flexResize(c, 1, { x: -2, y: -1 }, false);
  expect((back.flex as { sweep: number }).sweep).toBeGreaterThan(0);
  expect((back.flex as { sweep: number }).sweep).toBeLessThanOrEqual(1);
});

test('with Alt the radius changes and the sweep is kept', () => {
  const c = curve();
  const r = flexResize(c, 1, { x: 1.2, y: 0.2 }, true);
  const f = r.flex as { radius: number; sweep: number };
  expect(f.sweep).toBe(22.5);
  expect(f.radius).not.toBeCloseTo(R_M, 3);
  expect(f.radius).toBeGreaterThanOrEqual(FLEX_LIMITS.minRadius);
  const huge = flexResize(c, 1, { x: 50, y: 0 }, true).flex as { radius: number };
  expect(huge.radius).toBe(FLEX_LIMITS.maxRadius);
});

test('lengths clamp to the limits', () => {
  expect((flexResize(straight(), 1, { x: -3, y: 0 }, false).flex as { length: number }).length).toBe(FLEX_LIMITS.minLength);
  expect((flexResize(straight(), 1, { x: 30, y: 0 }, false).flex as { length: number }).length).toBe(FLEX_LIMITS.maxLength);
  const p = straight();
  const r = flexResize(p, 0, { x: 30, y: 0 }, false);
  expect((r.flex as { length: number }).length).toBe(FLEX_LIMITS.minLength);
  same(end(apply(p, r), 1), end(p, 1));
});

test('resizeFlex snapshots and restores flex and pose', () => {
  const doc = new Doc({ ...emptyLayout(), pieces: [straight()] });
  const cmd = resizeFlex('f', { flex: { length: 2 }, x: 1, y: 0, rot: 10 });
  cmd.do(doc);
  expect(doc.piece('f')).toMatchObject({ flex: { length: 2 }, x: 1, rot: 10 });
  cmd.undo(doc);
  expect(doc.piece('f')).toMatchObject({ flex: { length: 1 }, x: 0, rot: 0 });
  cmd.do(doc);
  expect(doc.piece('f')!.flex).toEqual({ length: 2 });
});
