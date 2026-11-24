import { test, expect } from 'vitest';
import { makePath, pathEnd, samplePath, mirrorPath } from '../../src/geom/path';

test('right 90° arc of radius 1 from origin heading 0 ends at (1,1) heading 90', () => {
  const e = pathEnd(makePath({ x: 0, y: 0 }, 0, [{ arc: { radius: 1, sweep: 90 } }]));
  expect(e.pos.x).toBeCloseTo(1); expect(e.pos.y).toBeCloseTo(1); expect(e.heading).toBeCloseTo(90);
});
test('path length sums segments', () => {
  const p = makePath({ x: 0, y: 0 }, 0, [{ line: 1 }, { arc: { radius: 2, sweep: -45 } }]);
  expect(p.length).toBeCloseTo(1 + Math.PI / 2);
});
test('samplePath midpoint of a line', () => {
  expect(samplePath(makePath({ x: 0, y: 0 }, 90, [{ line: 2 }]), 1).pos.y).toBeCloseTo(1);
});
test('mirrorPath flips a right turn into a left turn', () => {
  const e = pathEnd(mirrorPath(makePath({ x: 0, y: 0 }, 0, [{ arc: { radius: 1, sweep: 90 } }])));
  expect(e.pos.y).toBeCloseTo(-1); expect(e.heading).toBeCloseTo(-90);
});
