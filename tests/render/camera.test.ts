import { test, expect } from 'vitest';
import {
  type Camera, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, defaultCamera, worldToScreen, screenToWorld, zoomAt, fitBounds,
} from '../../src/render/camera';

const size = { x: 1280, y: 800 };
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

test('defaults: zoom 80 px per U, clamped to 10..400', () => {
  expect(DEFAULT_ZOOM).toBe(80);
  expect(MIN_ZOOM).toBe(10);
  expect(MAX_ZOOM).toBe(400);
  expect(defaultCamera()).toEqual({ cx: 0, cy: 0, zoom: 80 });
});

test('camera centre maps to the middle of the view; 1U is zoom pixels', () => {
  const cam: Camera = { cx: 3, cy: -2, zoom: 50 };
  close(worldToScreen(cam, size, { x: 3, y: -2 }), { x: 640, y: 400 });
  close(worldToScreen(cam, size, { x: 4, y: -1 }), { x: 690, y: 450 });
});

test('worldToScreen and screenToWorld round-trip', () => {
  const cam: Camera = { cx: 1.7, cy: -4.2, zoom: 123 };
  for (const p of [{ x: 0, y: 0 }, { x: -12.5, y: 7.25 }, { x: 100, y: -3 }]) {
    close(screenToWorld(cam, size, worldToScreen(cam, size, p)), p);
    close(worldToScreen(cam, size, screenToWorld(cam, size, p)), p);
  }
});

test('zoomAt keeps the world point under the cursor fixed', () => {
  const cam: Camera = { cx: 2, cy: 1, zoom: 80 };
  const cursor = { x: 200, y: 650 };
  const before = screenToWorld(cam, size, cursor);
  const z = zoomAt(cam, size, cursor, 1.5);
  expect(z.zoom).toBeCloseTo(120);
  close(screenToWorld(z, size, cursor), before);
  const out = zoomAt(cam, size, cursor, 0.5);
  close(screenToWorld(out, size, cursor), before);
});

test('zoomAt clamps zoom and still keeps the cursor point fixed', () => {
  const cam: Camera = { cx: 0, cy: 0, zoom: 300 };
  const cursor = { x: 1000, y: 100 };
  const before = screenToWorld(cam, size, cursor);
  const z = zoomAt(cam, size, cursor, 10);
  expect(z.zoom).toBe(MAX_ZOOM);
  close(screenToWorld(z, size, cursor), before);
  expect(zoomAt({ cx: 0, cy: 0, zoom: 12 }, size, cursor, 0.1).zoom).toBe(MIN_ZOOM);
});

test('fitBounds centres the box and makes it fit (with margin)', () => {
  const cam = fitBounds(defaultCamera(), size, { x: -4, y: -2 }, { x: 8, y: 4 });
  expect(cam.cx).toBeCloseTo(2);
  expect(cam.cy).toBeCloseTo(1);
  const tl = worldToScreen(cam, size, { x: -4, y: -2 });
  const br = worldToScreen(cam, size, { x: 8, y: 4 });
  expect(tl.x).toBeGreaterThanOrEqual(0);
  expect(tl.y).toBeGreaterThanOrEqual(0);
  expect(br.x).toBeLessThanOrEqual(size.x);
  expect(br.y).toBeLessThanOrEqual(size.y);
  // Width is the limiting dimension and nearly fills the view.
  expect(br.x - tl.x).toBeGreaterThan(size.x * 0.8);
});

test('fitBounds clamps zoom for tiny boxes and ignores empty bounds', () => {
  const tiny = fitBounds(defaultCamera(), size, { x: 1, y: 1 }, { x: 1, y: 1 });
  expect(tiny.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  expect(tiny.cx).toBe(1);
  const cam: Camera = { cx: 5, cy: 6, zoom: 70 };
  expect(fitBounds(cam, size, { x: Infinity, y: Infinity }, { x: -Infinity, y: -Infinity })).toEqual(cam);
  expect(fitBounds(cam, size, { x: -1000, y: 0 }, { x: 1000, y: 1 }).zoom).toBe(MIN_ZOOM);
});
