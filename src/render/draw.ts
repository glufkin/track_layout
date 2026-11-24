/**
 * Drawing helpers shared by the styles (re-exported from `style.ts`). They live in their own
 * module so that `styles/*.ts` can import them without an import cycle through `STYLES`.
 */
import { type Vec2, fromAngle } from '../geom/vec';
import { type RoutePath, samplePath } from '../geom/path';
import type { WorldConnector } from '../track/graph';

const RAD = Math.PI / 180;

/** Normal pointing right of travel (the +y side for heading 0). */
const rightOf = (headingDeg: number): Vec2 => ({ x: -Math.sin(headingDeg * RAD), y: Math.cos(headingDeg * RAD) });

/**
 * Add a route to the current path (no beginPath), offset sideways by `offset` U (positive =
 * right of travel). Lines and arcs are traced exactly, not sampled.
 */
export function traceRoute(ctx: CanvasRenderingContext2D, path: RoutePath, offset = 0): void {
  path.segments.forEach((s, i) => {
    const n = rightOf(s.heading);
    const start = { x: s.from.x + n.x * offset, y: s.from.y + n.y * offset };
    if (i === 0) ctx.moveTo(start.x, start.y);
    if (s.kind === 'line') {
      const u = fromAngle(s.heading);
      ctx.lineTo(start.x + u.x * s.length, start.y + u.y * s.length);
    } else {
      const sgn = s.sweep >= 0 ? 1 : -1;
      const cx = s.from.x + n.x * sgn * s.radius, cy = s.from.y + n.y * sgn * s.radius;
      const a0 = Math.atan2(s.from.y - cy, s.from.x - cx);
      ctx.arc(cx, cy, Math.max(0, s.radius - sgn * offset), a0, a0 + s.sweep * RAD, s.sweep < 0);
    }
  });
}

/** Stroke a route as a band `width` U wide using the current strokeStyle (optionally offset sideways). */
export function strokeRoute(ctx: CanvasRenderingContext2D, path: RoutePath, width: number, offset = 0): void {
  ctx.beginPath();
  traceRoute(ctx, path, offset);
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Add the part of a route between distances `d0` and `d1` (either order) as a sampled polyline. */
export function tracePartialRoute(ctx: CanvasRenderingContext2D, path: RoutePath, d0: number, d1: number): void {
  const n = Math.max(2, Math.ceil(Math.abs(d1 - d0) / 0.05));
  for (let i = 0; i <= n; i++) {
    const p = samplePath(path, d0 + ((d1 - d0) * i) / n).pos;
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
}

/** Peg / hole radius (U). */
export const PEG_R = 0.07;
/** Distance from the connector point to the peg / hole centre (U). */
export const PEG_REACH = 0.1;

/** Centre of the peg (male: sticks out along the outward heading) or hole (female: cut into the end). */
export function pegCentre(conn: WorldConnector, gender: 'm' | 'f'): Vec2 {
  const u = fromAngle(conn.heading);
  const k = gender === 'm' ? 1 : -1;
  return { x: conn.pos.x + u.x * k * PEG_REACH, y: conn.pos.y + u.y * k * PEG_REACH };
}

/**
 * Begin a new path holding a wooden-track connector shape: a round peg on a short neck that
 * sticks out past the end for a male connector, or the matching hole cut into the end for a
 * female one. Joined male and female shapes coincide exactly. The caller fills / strokes it.
 */
export function connectorShape(ctx: CanvasRenderingContext2D, conn: WorldConnector, gender: 'm' | 'f'): void {
  const n = rightOf(conn.heading);
  const k = gender === 'm' ? 1 : -1;
  const c = pegCentre(conn, gender);
  const neck = PEG_R * 0.55;
  const at = (base: Vec2, side: number): Vec2 => ({ x: base.x + n.x * side * neck, y: base.y + n.y * side * neck });
  ctx.beginPath();
  // Both subpaths wind clockwise on screen so a nonzero fill unions them.
  const rect = k === 1
    ? [at(conn.pos, -1), at(c, -1), at(c, 1), at(conn.pos, 1)]
    : [at(conn.pos, 1), at(c, 1), at(c, -1), at(conn.pos, -1)];
  rect.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
  ctx.closePath();
  ctx.moveTo(c.x + PEG_R, c.y);
  ctx.arc(c.x, c.y, PEG_R, 0, Math.PI * 2, false);
  ctx.closePath();
}

/** Add closed polygons to the current path (no beginPath). */
export function tracePolys(ctx: CanvasRenderingContext2D, polys: Vec2[][]): void {
  for (const poly of polys) {
    poly.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
  }
}

/** Mix a `#rgb` / `#rrggbb` colour toward white (`amount` > 0) or black (`amount` < 0). Other colour strings pass through. */
export function tint(color: string, amount: number): string {
  let m = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  const short = /^#([0-9a-f]{3})$/i.exec(color)?.[1];
  if (!m && short) m = short.split('').map((c) => c + c).join('');
  if (!m) return color;
  const target = amount >= 0 ? 255 : 0, a = Math.min(1, Math.abs(amount));
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(m!.slice(i, i + 2), 16) * (1 - a) + target * a));
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Approximate screen pixels per world unit, read from the current transform's x scale (the
 * styles are not told the zoom). It includes devicePixelRatio, which is fine for the rough
 * level-of-detail thresholds that use it. Returns 0 if the transform is unavailable.
 */
export function pixelsPerUnit(ctx: CanvasRenderingContext2D): number {
  const a = ctx.getTransform?.().a;
  return typeof a === 'number' && Number.isFinite(a) ? Math.abs(a) : 0;
}

/** A rectangle `along` × `across` centred at `c`, rotated to heading `h` degrees, added to the current path. */
export function orientedRect(ctx: CanvasRenderingContext2D, c: Vec2, h: number, along: number, across: number): void {
  const u = fromAngle(h), n = rightOf(h);
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b], i) => {
    const x = c.x + (u.x * a * along + n.x * b * across) / 2, y = c.y + (u.y * a * along + n.y * b * across) / 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

export { rightOf };
