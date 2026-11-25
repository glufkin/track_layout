import { type Vec2, fromAngle } from '../../geom/vec';
import { samplePath, type RoutePath } from '../../geom/path';
import { getPieceDef, pieceGeometry } from '../../track/catalog';
import { worldConnectors, worldFootprint, worldRoutePath } from '../../track/graph';
import { CAR_WIDTH, type CarPose } from '../../sim/motion';
import type { Piece, Train } from '../../model/types';
import type { PieceDrawOpts, Style } from '../style';
import { strokeRoute, connectorShape, tracePolys, tint, pegCentre, PEG_R } from '../draw';

export const TABLE = '#e8d3a9';
export const BAND = '#d9b27c';
const BAND_W = 0.5;
const BAND_EDGE = '#b8874f';
const GROOVE = '#a77b48';
const GROOVE_OFF = 0.12;
const GROOVE_W = 0.045;
const PEG = '#c49a62';
const PEG_EDGE = '#9a7240';
const DECK = '#a7743f';
const POST = '#7a5230';
const BUFFER = '#9c2f2f';
const HILL = '#7a9a4a';
const HILL_EDGE = '#56702f';
const PORTAL = '#3f2d1c';
const WHEEL = '#2b2b2b';
const PLANK = 1.5; // plank width (U)
const GRID = 0.5;

const RAD = Math.PI / 180;
const rightOf = (h: number): Vec2 => ({ x: -Math.sin(h * RAD), y: Math.cos(h * RAD) });

const routePaths = (p: Piece): RoutePath[] => pieceGeometry(p).routes.map((_, i) => worldRoutePath(p, i));

/** A small rectangle `along` × `across` centred at `c`, rotated to heading `h` (added to the path). */
function orientedRect(ctx: CanvasRenderingContext2D, c: Vec2, h: number, along: number, across: number): void {
  const u = fromAngle(h), n = rightOf(h);
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({
    x: c.x + (u.x * a * along + n.x * b * across) / 2, y: c.y + (u.y * a * along + n.y * b * across) / 2,
  }));
  pts.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
  ctx.closePath();
}

function background(ctx: CanvasRenderingContext2D, min: Vec2, max: Vec2, gridVisible: boolean): void {
  ctx.save();
  ctx.fillStyle = TABLE;
  ctx.fillRect(min.x, min.y, max.x - min.x, max.y - min.y);
  // About one CSS pixel for a typical view; the style does not know the zoom.
  const hair = Math.max(0.01, (max.x - min.x) / 1400);
  // Planks run along x; butt joints are staggered per row.
  ctx.beginPath();
  const r0 = Math.floor(min.y / PLANK), r1 = Math.ceil(max.y / PLANK);
  for (let r = r0; r <= r1; r++) {
    const y = r * PLANK;
    ctx.moveTo(min.x, y);
    ctx.lineTo(max.x, y);
    const joint = 7, shift = ((r * 2.75) % joint + joint) % joint;
    for (let x = Math.floor((min.x - shift) / joint) * joint + shift; x <= max.x; x += joint) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + PLANK);
    }
  }
  ctx.strokeStyle = 'rgba(120,80,30,0.16)';
  ctx.lineWidth = hair * 1.5;
  ctx.stroke();
  if (gridVisible) {
    ctx.beginPath();
    for (let x = Math.floor(min.x / GRID) * GRID; x <= max.x; x += GRID) { ctx.moveTo(x, min.y); ctx.lineTo(x, max.y); }
    for (let y = Math.floor(min.y / GRID) * GRID; y <= max.y; y += GRID) { ctx.moveTo(min.x, y); ctx.lineTo(max.x, y); }
    ctx.strokeStyle = 'rgba(90,60,20,0.09)';
    ctx.lineWidth = hair;
    ctx.stroke();
  }
  ctx.restore();
}

function bridgeUnderside(ctx: CanvasRenderingContext2D, path: RoutePath): void {
  const n = Math.max(2, Math.round(path.length / 0.5));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const s = samplePath(path, (path.length * (0.1 + (0.8 * i) / n)));
    const r = rightOf(s.heading);
    for (const side of [-1, 1]) {
      orientedRect(ctx, { x: s.pos.x + r.x * side * 0.38, y: s.pos.y + r.y * side * 0.38 }, s.heading, 0.12, 0.1);
    }
  }
  ctx.fillStyle = POST;
  ctx.fill();
  ctx.strokeStyle = DECK;
  strokeRoute(ctx, path, 0.7);
}

function piece(ctx: CanvasRenderingContext2D, p: Piece, _opts: PieceDrawOpts): void {
  const def = getPieceDef(p.type);
  const paths = routePaths(p);
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  if (def.bridge) for (const path of paths) bridgeUnderside(ctx, path);
  if (def.ramp) {
    // The raised half casts a shadow that grows toward the high end.
    const a = samplePath(paths[0], 0).pos, b = samplePath(paths[0], paths[0].length).pos;
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.save();
    ctx.translate(0.06, 0.06);
    ctx.beginPath();
    tracePolys(ctx, worldFootprint(p));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = BAND_EDGE;
  for (const path of paths) strokeRoute(ctx, path, BAND_W + 0.04);
  ctx.strokeStyle = BAND;
  for (const path of paths) strokeRoute(ctx, path, BAND_W);
  ctx.strokeStyle = GROOVE;
  for (const path of paths) for (const off of [-GROOVE_OFF, GROOVE_OFF]) strokeRoute(ctx, path, GROOVE_W, off);

  if (def.ramp) {
    // Ramps blend between the levels: lighter toward the high end.
    const a = samplePath(paths[0], 0).pos, b = samplePath(paths[0], paths[0].length).pos;
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.3)');
    ctx.strokeStyle = g;
    strokeRoute(ctx, paths[0], BAND_W);
  }

  if (def.family === 'buffer') {
    const e = samplePath(paths[0], paths[0].length);
    const u = fromAngle(e.heading);
    ctx.beginPath();
    orientedRect(ctx, { x: e.pos.x - u.x * 0.09, y: e.pos.y - u.y * 0.09 }, e.heading, 0.16, BAND_W + 0.08);
    ctx.fillStyle = BUFFER;
    ctx.fill();
    ctx.strokeStyle = tint(BUFFER, -0.4);
    ctx.lineWidth = 0.02;
    ctx.stroke();
  }

  // Pegs and holes look the same, so a joined pair reads as one seam whichever end is drawn last.
  const genders = pieceGeometry(p).connectors;
  ctx.fillStyle = PEG;
  ctx.strokeStyle = PEG_EDGE;
  ctx.lineWidth = 0.015;
  for (const c of worldConnectors(p)) {
    const g = genders[c.index].gender;
    connectorShape(ctx, c, g);
    ctx.fill();
    const m = pegCentre(c, g);
    ctx.beginPath();
    ctx.arc(m.x, m.y, PEG_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function tunnelCover(ctx: CanvasRenderingContext2D, p: Piece): void {
  ctx.save();
  ctx.lineCap = 'butt';
  for (const path of routePaths(p)) {
    ctx.strokeStyle = HILL_EDGE;
    strokeRoute(ctx, path, 0.96);
    ctx.strokeStyle = HILL;
    strokeRoute(ctx, path, 0.9);
    ctx.strokeStyle = tint(HILL, 0.2);
    strokeRoute(ctx, path, 0.35);
    ctx.beginPath();
    for (const d of [0.05, path.length - 0.05]) {
      const s = samplePath(path, d);
      orientedRect(ctx, s.pos, s.heading, 0.1, 0.96);
    }
    ctx.fillStyle = PORTAL;
    ctx.fill();
  }
  ctx.restore();
}

function car(ctx: CanvasRenderingContext2D, c: CarPose, train: Train): void {
  const L = c.length, W = CAR_WIDTH;
  ctx.save();
  ctx.translate(c.center.x, c.center.y);
  ctx.rotate(c.heading * RAD);
  // Wheel nubs poking out the sides, and coupling stubs.
  ctx.fillStyle = WHEEL;
  for (const x of [-L * 0.3, L * 0.3]) for (const y of [-W / 2 - 0.04, W / 2 - 0.02]) ctx.fillRect(x - 0.07, y, 0.14, 0.06);
  ctx.fillRect(-L / 2 - 0.05, -0.025, 0.05, 0.05);
  if (!c.isLoco) ctx.fillRect(L / 2, -0.025, 0.05, 0.05);

  const body = c.isLoco ? train.color : tint(train.color, 0.45);
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, 0.1);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = tint(train.color, -0.35);
  ctx.lineWidth = 0.03;
  ctx.stroke();
  if (c.isLoco) {
    ctx.beginPath();
    ctx.roundRect(-L / 2 + 0.06, -W / 2 + 0.06, L * 0.32, W - 0.12, 0.05);
    ctx.fillStyle = tint(train.color, -0.25);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(L * 0.28, 0, 0.075, 0, Math.PI * 2);
    ctx.fillStyle = '#111111';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.roundRect(-L / 2 + 0.1, -W / 2 + 0.08, L - 0.2, W - 0.16, 0.05);
    ctx.strokeStyle = tint(train.color, 0.15);
    ctx.lineWidth = 0.025;
    ctx.stroke();
  }
  ctx.restore();
}

export const WOODEN: Style = { id: 'wooden', name: 'Wooden', background, piece, tunnelCover, car };
