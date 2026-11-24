import type { Vec2 } from '../../geom/vec';
import { fromAngle } from '../../geom/vec';
import { samplePath, type RoutePath } from '../../geom/path';
import { getPieceDef } from '../../track/catalog';
import { worldConnectors, worldFootprint, worldRoutePath } from '../../track/graph';
import { CAR_WIDTH, type CarPose } from '../../sim/motion';
import type { Piece, Train } from '../../model/types';
import type { PieceDrawOpts, Style } from '../style';
import { strokeRoute, tracePolys, tint, orientedRect, rightOf } from '../draw';

const GRASS = '#7da35a';
const BALLAST = '#8c8a84';
const BALLAST_EDGE = '#6f6d68';
const SLEEPER = '#6b4a2b';
const RAIL = '#9aa0a6';
const RAIL_SHADOW = '#5f6368';
const BED_W = 0.5;
const SLEEPER_STEP = 0.15;
const SLEEPER_LEN = 0.42;
const RAIL_OFF = 0.1;
const DECK = '#7c7468';
const PIER = '#5d574e';
const STONE = '#9b9588';
const STONE_DARK = '#4a463f';
const HILL = '#5f8a3f';
const HILL_EDGE = '#436a2b';
const BUFFER = '#8a2c2c';
const GRID = 0.5;
const RAD = Math.PI / 180;

const routePaths = (p: Piece): RoutePath[] => getPieceDef(p.type).routes.map((_, i) => worldRoutePath(p, i));

function background(ctx: CanvasRenderingContext2D, min: Vec2, max: Vec2, gridVisible: boolean): void {
  ctx.save();
  ctx.fillStyle = GRASS;
  ctx.fillRect(min.x, min.y, max.x - min.x, max.y - min.y);
  if (gridVisible) {
    const hair = Math.max(0.01, (max.x - min.x) / 1400);
    ctx.beginPath();
    for (let x = Math.floor(min.x / GRID) * GRID; x <= max.x; x += GRID) { ctx.moveTo(x, min.y); ctx.lineTo(x, max.y); }
    for (let y = Math.floor(min.y / GRID) * GRID; y <= max.y; y += GRID) { ctx.moveTo(min.x, y); ctx.lineTo(max.x, y); }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = hair;
    ctx.stroke();
  }
  ctx.restore();
}

function sleepers(ctx: CanvasRenderingContext2D, path: RoutePath): void {
  const n = Math.max(1, Math.round(path.length / SLEEPER_STEP));
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const s = samplePath(path, ((i + 0.5) * path.length) / n);
    orientedRect(ctx, s.pos, s.heading, 0.06, SLEEPER_LEN);
  }
  ctx.fillStyle = SLEEPER;
  ctx.fill();
}

function bridgeSupports(ctx: CanvasRenderingContext2D, path: RoutePath): void {
  ctx.lineCap = 'butt';
  ctx.strokeStyle = PIER;
  strokeRoute(ctx, path, 0.74);
  const n = Math.max(2, Math.round(path.length / 0.5));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const s = samplePath(path, path.length * (0.1 + (0.8 * i) / n));
    const r = rightOf(s.heading);
    for (const side of [-1, 1]) orientedRect(ctx, { x: s.pos.x + r.x * side * 0.4, y: s.pos.y + r.y * side * 0.4 }, s.heading, 0.14, 0.1);
  }
  ctx.fillStyle = PIER;
  ctx.fill();
  ctx.strokeStyle = DECK;
  strokeRoute(ctx, path, 0.68);
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
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = BALLAST_EDGE;
  for (const path of paths) strokeRoute(ctx, path, BED_W + 0.04);
  ctx.strokeStyle = BALLAST;
  for (const path of paths) strokeRoute(ctx, path, BED_W);
  for (const path of paths) sleepers(ctx, path);
  for (const off of [-RAIL_OFF, RAIL_OFF]) {
    ctx.strokeStyle = RAIL_SHADOW;
    for (const path of paths) strokeRoute(ctx, path, 0.05, off);
    ctx.strokeStyle = RAIL;
    for (const path of paths) strokeRoute(ctx, path, 0.032, off);
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
    orientedRect(ctx, { x: e.pos.x - u.x * 0.07, y: e.pos.y - u.y * 0.07 }, e.heading, 0.12, BED_W + 0.06);
    ctx.fillStyle = BUFFER;
    ctx.fill();
  }
  // Connectors: just a thin joint line across the bed end (no pegs).
  ctx.beginPath();
  for (const c of worldConnectors(p)) orientedRect(ctx, c.pos, c.heading, 0.012, BED_W);
  ctx.fillStyle = BALLAST_EDGE;
  ctx.fill();
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
    ctx.strokeStyle = tint(HILL, 0.18);
    strokeRoute(ctx, path, 0.4);
    // Stone portals: a block with a dark opening at each end.
    for (const d of [0.07, path.length - 0.07]) {
      const s = samplePath(path, d);
      ctx.beginPath();
      orientedRect(ctx, s.pos, s.heading, 0.14, 0.96);
      ctx.fillStyle = STONE;
      ctx.fill();
      ctx.strokeStyle = tint(STONE, -0.35);
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.beginPath();
      orientedRect(ctx, s.pos, s.heading, 0.15, 0.56);
      ctx.fillStyle = STONE_DARK;
      ctx.fill();
    }
  }
  ctx.restore();
}

function car(ctx: CanvasRenderingContext2D, c: CarPose, train: Train): void {
  const L = c.length, W = CAR_WIDTH * 0.72; // slim bodies
  ctx.save();
  ctx.translate(c.center.x, c.center.y);
  ctx.rotate(c.heading * RAD);
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(-L / 2 - 0.04, -0.02, 0.04, 0.04);
  if (!c.isLoco) ctx.fillRect(L / 2, -0.02, 0.04, 0.04);
  ctx.fillRect(-L * 0.32 - 0.08, -W / 2 - 0.02, 0.16, 0.03);
  ctx.fillRect(-L * 0.32 - 0.08, W / 2 - 0.01, 0.16, 0.03);
  ctx.fillRect(L * 0.32 - 0.08, -W / 2 - 0.02, 0.16, 0.03);
  ctx.fillRect(L * 0.32 - 0.08, W / 2 - 0.01, 0.16, 0.03);
  const body = c.isLoco ? train.color : tint(train.color, 0.4);
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, 0.05);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = tint(train.color, -0.4);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  // Darker roof lines running the length of the body.
  ctx.beginPath();
  for (const y of [-W * 0.18, W * 0.18]) { ctx.moveTo(-L / 2 + 0.06, y); ctx.lineTo(L / 2 - 0.06, y); }
  ctx.strokeStyle = tint(train.color, -0.35);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  if (c.isLoco) {
    ctx.beginPath();
    ctx.roundRect(-L / 2 + 0.05, -W / 2 + 0.05, L * 0.3, W - 0.1, 0.03);
    ctx.fillStyle = tint(train.color, -0.3);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(L * 0.4, 0, 0.04, 0, Math.PI * 2);
    ctx.fillStyle = '#f5e9b0';
    ctx.fill();
  }
  ctx.restore();
}

export const MODEL: Style = { id: 'model', name: 'Model train', background, piece, tunnelCover, car };
