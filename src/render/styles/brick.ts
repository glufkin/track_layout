import type { Vec2 } from '../../geom/vec';
import { fromAngle } from '../../geom/vec';
import { samplePath, type RoutePath } from '../../geom/path';
import { getPieceDef, pieceGeometry } from '../../track/catalog';
import { worldConnectors, worldFootprint, worldRoutePath } from '../../track/graph';
import { CAR_WIDTH, type CarPose } from '../../sim/motion';
import type { Piece, Train } from '../../model/types';
import type { PieceDrawOpts, Style } from '../style';
import { strokeRoute, tracePolys, tint, orientedRect, rightOf, pixelsPerUnit } from '../draw';

const BASEPLATE = '#3a9a3a';
const STUD = '#46ad46';
const STUD_SHADE = '#2c7a2c';
const PLATE = '#4b5057';
const PLATE_STUD = '#5a6068';
const PLATE_STUD_SHADE = '#363a40';
const RAIL = '#c4c9cf';
const RAIL_EDGE = '#8d9298';
const BRICK = '#b5483a';
const BRICK_DARK = '#7e2f25';
const BRICK_LINE = '#d9a79e';
const OPENING = '#22262b';
const SUPPORT = '#d9b23a';
const SUPPORT_SHADE = '#a8841f';
const BUFFER = '#c0392b';
const BED_W = 0.5;
const STUD_STEP = 0.25;
const STUD_R = 0.07;
/** Baseplate studs are skipped below this many pixels per world unit (they would be an unreadable mesh and cost thousands of arcs). */
export const STUD_MIN_ZOOM = 30;
const RAD = Math.PI / 180;

const routePaths = (p: Piece): RoutePath[] => pieceGeometry(p).routes.map((_, i) => worldRoutePath(p, i));

/** Add stud circles (one subpath each) at the given points to the current path. */
function studAt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function background(ctx: CanvasRenderingContext2D, min: Vec2, max: Vec2, _gridVisible: boolean): void {
  ctx.save();
  ctx.fillStyle = BASEPLATE;
  ctx.fillRect(min.x, min.y, max.x - min.x, max.y - min.y);
  // The style is not told the zoom; read the scale from the transform the renderer applied.
  if (pixelsPerUnit(ctx) >= STUD_MIN_ZOOM) {
    const x0 = Math.floor(min.x / STUD_STEP), x1 = Math.ceil(max.x / STUD_STEP);
    const y0 = Math.floor(min.y / STUD_STEP), y1 = Math.ceil(max.y / STUD_STEP);
    ctx.beginPath();
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) studAt(ctx, (i + 0.5) * STUD_STEP, (j + 0.5) * STUD_STEP, STUD_R);
    ctx.fillStyle = STUD;
    ctx.fill();
    ctx.strokeStyle = STUD_SHADE;
    ctx.lineWidth = 0.012;
    ctx.stroke();
  }
  ctx.restore();
}

function plateStuds(ctx: CanvasRenderingContext2D, path: RoutePath): void {
  const n = Math.max(1, Math.round(path.length / STUD_STEP));
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const s = samplePath(path, ((i + 0.5) * path.length) / n);
    const r = rightOf(s.heading);
    for (const side of [-1, 1]) studAt(ctx, s.pos.x + r.x * side * 0.2, s.pos.y + r.y * side * 0.2, 0.045);
  }
  ctx.fillStyle = PLATE_STUD;
  ctx.fill();
  ctx.strokeStyle = PLATE_STUD_SHADE;
  ctx.lineWidth = 0.01;
  ctx.stroke();
}

function bridgeSupports(ctx: CanvasRenderingContext2D, path: RoutePath): void {
  const n = Math.max(2, Math.round(path.length / 0.5));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const s = samplePath(path, path.length * (0.1 + (0.8 * i) / n));
    const r = rightOf(s.heading);
    for (const side of [-1, 1]) orientedRect(ctx, { x: s.pos.x + r.x * side * 0.4, y: s.pos.y + r.y * side * 0.4 }, s.heading, 0.16, 0.12);
  }
  ctx.fillStyle = SUPPORT;
  ctx.fill();
  ctx.strokeStyle = SUPPORT_SHADE;
  ctx.lineWidth = 0.015;
  ctx.stroke();
  ctx.strokeStyle = SUPPORT_SHADE;
  strokeRoute(ctx, path, 0.72);
}

function piece(ctx: CanvasRenderingContext2D, p: Piece, _opts: PieceDrawOpts): void {
  const def = getPieceDef(p.type);
  const paths = routePaths(p);
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  if (def.bridge) for (const path of paths) bridgeSupports(ctx, path);
  if (def.ramp) {
    ctx.save();
    ctx.translate(0.06, 0.06);
    ctx.beginPath();
    tracePolys(ctx, worldFootprint(p));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = tint(PLATE, -0.4);
  for (const path of paths) strokeRoute(ctx, path, BED_W + 0.04);
  ctx.strokeStyle = PLATE;
  for (const path of paths) strokeRoute(ctx, path, BED_W);
  for (const path of paths) plateStuds(ctx, path);
  for (const off of [-0.1, 0.1]) {
    ctx.strokeStyle = RAIL_EDGE;
    for (const path of paths) strokeRoute(ctx, path, 0.075, off);
    ctx.strokeStyle = RAIL;
    for (const path of paths) strokeRoute(ctx, path, 0.055, off);
  }
  if (def.ramp) {
    const a = samplePath(paths[0], 0).pos, b = samplePath(paths[0], paths[0].length).pos;
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.28)');
    ctx.strokeStyle = g;
    strokeRoute(ctx, paths[0], BED_W);
  }
  if (def.family === 'buffer') {
    const e = samplePath(paths[0], paths[0].length);
    const u = fromAngle(e.heading);
    ctx.beginPath();
    orientedRect(ctx, { x: e.pos.x - u.x * 0.09, y: e.pos.y - u.y * 0.09 }, e.heading, 0.18, BED_W + 0.06);
    ctx.fillStyle = BUFFER;
    ctx.fill();
    ctx.strokeStyle = tint(BUFFER, -0.4);
    ctx.lineWidth = 0.02;
    ctx.stroke();
  }
  // Connectors: a plain joint line across the plate end.
  ctx.beginPath();
  for (const c of worldConnectors(p)) orientedRect(ctx, c.pos, c.heading, 0.012, BED_W);
  ctx.fillStyle = tint(PLATE, -0.5);
  ctx.fill();
  ctx.restore();
}

function tunnelCover(ctx: CanvasRenderingContext2D, p: Piece): void {
  ctx.save();
  ctx.lineCap = 'butt';
  for (const path of routePaths(p)) {
    ctx.strokeStyle = BRICK_DARK;
    strokeRoute(ctx, path, 0.96);
    ctx.strokeStyle = BRICK;
    strokeRoute(ctx, path, 0.9);
    // Brick courses across the roof.
    const n = Math.max(2, Math.round(path.length / 0.12));
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const s = samplePath(path, (i * path.length) / n);
      orientedRect(ctx, s.pos, s.heading, 0.012, 0.9);
    }
    ctx.save();
    ctx.fillStyle = BRICK_LINE;
    ctx.globalAlpha *= 0.5;
    ctx.fill();
    ctx.restore();
    // Brick arch at each end: a block with a dark rounded opening.
    for (const d of [0.07, path.length - 0.07]) {
      const s = samplePath(path, d);
      ctx.beginPath();
      orientedRect(ctx, s.pos, s.heading, 0.14, 0.96);
      ctx.fillStyle = tint(BRICK, -0.15);
      ctx.fill();
      ctx.strokeStyle = BRICK_DARK;
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.save();
      ctx.translate(s.pos.x, s.pos.y);
      ctx.rotate(s.heading * RAD);
      ctx.beginPath();
      ctx.roundRect(-0.08, -0.29, 0.16, 0.58, [0.08, 0.08, 0.08, 0.08]);
      ctx.fillStyle = OPENING;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 0.34, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = BRICK_LINE;
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

function car(ctx: CanvasRenderingContext2D, c: CarPose, train: Train): void {
  const L = c.length, W = CAR_WIDTH;
  ctx.save();
  ctx.translate(c.center.x, c.center.y);
  ctx.rotate(c.heading * RAD);
  ctx.fillStyle = '#222';
  for (const x of [-L * 0.3, L * 0.3]) for (const y of [-W / 2 - 0.04, W / 2 - 0.02]) ctx.fillRect(x - 0.08, y, 0.16, 0.06);
  const body = c.isLoco ? train.color : tint(train.color, 0.35);
  ctx.beginPath();
  ctx.rect(-L / 2, -W / 2, L, W);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = tint(train.color, -0.45);
  ctx.lineWidth = 0.035;
  ctx.stroke();
  if (c.isLoco) {
    // Cab block at the rear (the loco's tail is -x).
    ctx.beginPath();
    ctx.rect(-L / 2 + 0.04, -W / 2 + 0.05, L * 0.3, W - 0.1);
    ctx.fillStyle = tint(train.color, -0.25);
    ctx.fill();
  }
  // Studs on top, in a grid.
  const cols = Math.max(1, Math.floor((L - 0.1) / 0.25)), rows = Math.max(1, Math.floor((W - 0.05) / 0.25));
  ctx.beginPath();
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    studAt(ctx, -((cols - 1) * 0.25) / 2 + i * 0.25 + (c.isLoco ? 0.05 : 0), -((rows - 1) * 0.25) / 2 + j * 0.25, 0.065);
  }
  ctx.fillStyle = tint(body, 0.2);
  ctx.fill();
  ctx.strokeStyle = tint(train.color, -0.45);
  ctx.lineWidth = 0.015;
  ctx.stroke();
  ctx.restore();
}

export const BRICK_STYLE: Style = { id: 'brick', name: 'Toy brick', background, piece, tunnelCover, car };
