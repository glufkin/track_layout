import { test, expect } from 'vitest';
import { normDeg, applyPose, composePose, invertPose } from '../../src/geom/vec';

test('normDeg wraps into (-180,180]', () => { expect(normDeg(540)).toBe(180); expect(normDeg(-190)).toBe(170); });
test('applyPose rotates then translates', () => {
  const p = applyPose({ x: 1, y: 2, rot: 90 }, { x: 1, y: 0 });
  expect(p.x).toBeCloseTo(1); expect(p.y).toBeCloseTo(3);
});
test('composePose then invertPose is identity', () => {
  const a = { x: 3, y: -1, rot: 30 }, b = { x: 0.5, y: 2, rot: -75 };
  const c = composePose(invertPose(a), composePose(a, b));
  expect(c.x).toBeCloseTo(b.x); expect(c.y).toBeCloseTo(b.y); expect(normDeg(c.rot)).toBeCloseTo(b.rot);
});
