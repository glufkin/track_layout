import type { Vec2 } from '../geom/vec';

/**
 * The view onto the (unbounded) table. `cx, cy` is the world point at the centre of the view;
 * `zoom` is CSS pixels per U. All `size` arguments are the view size in CSS pixels.
 */
export interface Camera { cx: number; cy: number; zoom: number }

export const DEFAULT_ZOOM = 80;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 400;
/** World margin (U) kept around a box fitted with `fitBounds`. */
export const FIT_MARGIN = 1;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
export const defaultCamera = (): Camera => ({ cx: 0, cy: 0, zoom: DEFAULT_ZOOM });

export function worldToScreen(cam: Camera, size: Vec2, p: Vec2): Vec2 {
  return { x: (p.x - cam.cx) * cam.zoom + size.x / 2, y: (p.y - cam.cy) * cam.zoom + size.y / 2 };
}

export function screenToWorld(cam: Camera, size: Vec2, p: Vec2): Vec2 {
  return { x: (p.x - size.x / 2) / cam.zoom + cam.cx, y: (p.y - size.y / 2) / cam.zoom + cam.cy };
}

/** Multiply the zoom by `factor` (clamped), keeping the world point under `screenPt` fixed. */
export function zoomAt(cam: Camera, size: Vec2, screenPt: Vec2, factor: number): Camera {
  const w = screenToWorld(cam, size, screenPt);
  const zoom = clampZoom(cam.zoom * factor);
  return { zoom, cx: w.x - (screenPt.x - size.x / 2) / zoom, cy: w.y - (screenPt.y - size.y / 2) / zoom };
}

/** Centre on the box `min..max` and zoom so it fits with `FIT_MARGIN` around it. Empty boxes leave `cam` unchanged. */
export function fitBounds(cam: Camera, size: Vec2, min: Vec2, max: Vec2): Camera {
  if (!(max.x >= min.x && max.y >= min.y) || !Number.isFinite(max.x - min.x) || !Number.isFinite(max.y - min.y)) {
    return { ...cam };
  }
  const zoom = clampZoom(Math.min(size.x / (max.x - min.x + 2 * FIT_MARGIN), size.y / (max.y - min.y + 2 * FIT_MARGIN)));
  return { cx: (min.x + max.x) / 2, cy: (min.y + max.y) / 2, zoom };
}
