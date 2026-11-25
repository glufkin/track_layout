import { type Pose, type Vec2, fromAngle } from '../geom/vec';
import { samplePath } from '../geom/path';
import { getPieceDef, pieceGeometry } from '../track/catalog';
import { worldFootprint, worldRoutePath } from '../track/graph';
import { carPoses, CAR_LEN, CAR_WIDTH, COUPLING, LOCO_LEN, type CarPose } from '../sim/motion';
import type { Doc } from '../model/doc';
import { MAX_LEVEL, type Piece, type StyleId, type Train } from '../model/types';
import { type Camera, screenToWorld } from './camera';
import { STYLES, type Style } from './style';
import { connectorShape, pegCentre, PEG_R, tracePartialRoute, tracePolys } from './draw';

export interface Overlay {
  selectedPieces: Set<string>;
  selectedTrain?: string;
  ghost?: { piece: Piece; valid: boolean };
  ghostTrain?: CarPose[];
  /** False when the ghost train could not be placed there (drawn red, like an invalid piece ghost). */
  ghostTrainValid?: boolean;
  showConnectors: boolean;
  /** A near-miss ring that could not be closed, flashed red (the app clears it after FLASH_MS). */
  flashRing?: Vec2;
  /** Sketch mode (spec §5.3, §5.11): the stroke being drawn and its live ghost. */
  sketch?: SketchOverlay;
}

export interface SketchOverlay {
  /** The raw stroke, in world units. */
  points: Vec2[];
  /** Ghost pieces (drawn at 50% alpha in the current style). */
  ghost: Piece[];
  /** Level of the ghost's leading end. */
  level: number;
  /** Index of the first stroke point drawn red, or null. */
  redFrom: number | null;
  pendingRamp: -1 | 0 | 1;
  /** The ghost's leading end, marked with a dot (and the pending ramp's badge). */
  lead?: Vec2;
  /** Where a stroke start was refused: a red ✕. */
  refusedAt?: Vec2;
  /** Switches the stroke will create, drawn as outlines. */
  switchPreview?: Piece[];
}

/** How long a near-miss ring that could not be closed flashes red. */
export const FLASH_MS = 400;

const SHADOW = 'rgba(0,0,0,0.25)';
const SHADOW_STEP = 0.06;
const LIFTED_ALPHA = 0.4;
const GHOST_ALPHA = 0.5;
const SWITCH_ARROW = 'rgba(60,35,15,0.8)';
const CONNECTOR = 'rgba(46,160,67,0.9)';
const NEAR_MISS = '#ff8c00';
const NEAR_MISS_R = 0.15;
const FLASH = '#e53935';
const OVERLAP = 'rgba(229,57,53,0.35)';
const SELECT = '#1e88e5';
const CRASH = '#e53935';
const INVALID = 'rgba(229,57,53,0.6)';
const STROKE = 'rgba(30,136,229,0.55)';
const STROKE_RED = 'rgba(229,57,53,0.8)';
const LEAD = '#1e88e5';
const REFUSED = '#e53935';
const GHOST_TRAIN: Train = {
  id: 'ghost', cars: 0, color: '#808080', speed: 0, running: false, head: null, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null,
};
export const INVALID_TRAIN_COLOR = '#e53935';
const INVALID_GHOST_TRAIN: Train = { ...GHOST_TRAIN, color: INVALID_TRAIN_COLOR };

/** Car poses for a lifted train: the loco centred on `pose`, cars laid straight behind it along its heading. */
export function liftedCarPoses(pose: Pose, cars: number): CarPose[] {
  const u = fromAngle(pose.rot);
  const out: CarPose[] = [];
  let back = 0;
  for (let i = 0; i <= cars; i++) {
    if (i > 0) back += (i === 1 ? LOCO_LEN / 2 : CAR_LEN / 2) + COUPLING + CAR_LEN / 2;
    out.push({
      center: { x: pose.x - u.x * back, y: pose.y - u.y * back }, heading: pose.rot,
      length: i === 0 ? LOCO_LEN : CAR_LEN, level: 0, isLoco: i === 0, pieceIds: [],
    });
  }
  return out;
}

function fillPolys(ctx: CanvasRenderingContext2D, polys: Vec2[][], style: string): void {
  ctx.beginPath();
  tracePolys(ctx, polys);
  ctx.fillStyle = style;
  ctx.fill();
}

/** An arrow along the switch's active route, pointing away from the entry connector. */
function switchArrow(ctx: CanvasRenderingContext2D, p: Piece): void {
  const sw = getPieceDef(p.type).switch;
  if (!sw) return;
  const route = sw.routes[p.switch?.state ?? 0];
  const path = worldRoutePath(p, route);
  const forward = pieceGeometry(p).routes[route].from === sw.entry;
  const [d0, d1] = forward ? [0.2 * path.length, 0.72 * path.length] : [0.8 * path.length, 0.28 * path.length];
  ctx.save();
  ctx.strokeStyle = SWITCH_ARROW;
  ctx.fillStyle = SWITCH_ARROW;
  ctx.lineWidth = 0.05;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  tracePartialRoute(ctx, path, d0, d1);
  ctx.stroke();
  const tip = samplePath(path, d1);
  const u = fromAngle(tip.heading + (forward ? 0 : 180));
  const n = { x: -u.y, y: u.x };
  const a = { x: tip.pos.x + u.x * 0.1, y: tip.pos.y + u.y * 0.1 };
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(tip.pos.x - u.x * 0.06 + n.x * 0.1, tip.pos.y - u.y * 0.06 + n.y * 0.1);
  ctx.lineTo(tip.pos.x - u.x * 0.06 - n.x * 0.1, tip.pos.y - u.y * 0.06 - n.y * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function crashStar(ctx: CanvasRenderingContext2D, at: Vec2, px: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.3 : 0.13;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = at.x + r * Math.cos(a), y = at.y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = CRASH;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();
}

function outlineCars(ctx: CanvasRenderingContext2D, cars: CarPose[]): void {
  for (const c of cars) {
    const u = fromAngle(c.heading), n = { x: -u.y, y: u.x };
    const hl = c.length / 2 + 0.05, hw = CAR_WIDTH / 2 + 0.06;
    ctx.beginPath();
    [[1, 1], [1, -1], [-1, -1], [-1, 1]].forEach(([a, b], i) => {
      const x = c.center.x + u.x * a * hl + n.x * b * hw, y = c.center.y + u.y * a * hl + n.y * b * hw;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

function drawPiece(ctx: CanvasRenderingContext2D, style: Style, p: Piece, selected: boolean): void {
  ctx.save();
  style.piece(ctx, p, { selected });
  ctx.restore();
}

/**
 * Draw the whole scene. `size` is the view size in **CSS pixels**; the caller (the App) has
 * already scaled `ctx` by `devicePixelRatio` (e.g. `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`),
 * so this function only composes the camera transform on top of the current one and restores
 * it afterwards.
 */
export function render(
  ctx: CanvasRenderingContext2D, doc: Doc, cam: Camera, size: Vec2, overlay: Overlay, styleId: StyleId,
): void {
  const style = STYLES[styleId] ?? STYLES.wooden;
  const px = 1 / cam.zoom; // one CSS pixel in U
  const { pieces, trains } = doc.layout;

  ctx.save();
  ctx.translate(size.x / 2, size.y / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.cx, -cam.cy);

  // 1. Background.
  ctx.save();
  style.background(ctx, screenToWorld(cam, size, { x: 0, y: 0 }), screenToWorld(cam, size, size), doc.layout.settings.gridVisible);
  ctx.restore();

  const placed = trains.filter((t) => t.head !== null).map((t) => ({ train: t, cars: carPoses(doc, t) }));

  // 2. Level by level, lowest first.
  for (let L = 0; L <= MAX_LEVEL; L++) {
    const here = pieces.filter((p) => p.level === L);
    if (L > 0 && here.length > 0) {
      ctx.save();
      ctx.translate(SHADOW_STEP * L, SHADOW_STEP * L);
      // One path for the whole level so overlapping bands do not darken twice.
      fillPolys(ctx, here.flatMap(worldFootprint), SHADOW);
      ctx.restore();
    }
    const ramps = here.filter((p) => getPieceDef(p.type).ramp);
    for (const p of here) if (!getPieceDef(p.type).ramp) drawPiece(ctx, style, p, overlay.selectedPieces.has(p.id));
    for (const p of ramps) drawPiece(ctx, style, p, overlay.selectedPieces.has(p.id));
    for (const p of here) if (getPieceDef(p.type).switch) switchArrow(ctx, p);
    for (const { train, cars } of placed) {
      for (const c of cars) {
        if (c.level !== L) continue;
        ctx.save();
        style.car(ctx, c, train);
        ctx.restore();
      }
    }
    if (L === 0) {
      for (const p of here) {
        if (!getPieceDef(p.type).tunnel) continue;
        ctx.save();
        style.tunnelCover(ctx, p);
        ctx.restore();
      }
    }
  }

  // 3. Lifted trains as translucent ghosts (never with a crash marker).
  for (const t of trains) {
    if (t.head !== null || !t.lifted) continue;
    for (const c of liftedCarPoses(t.lifted, t.cars)) {
      ctx.save();
      ctx.globalAlpha = LIFTED_ALPHA;
      style.car(ctx, c, t);
      ctx.restore();
    }
  }

  // 4. Overlays.
  ctx.save();
  if (overlay.showConnectors) {
    ctx.fillStyle = CONNECTOR;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * px;
    for (const c of doc.graph.open) {
      const p = doc.piece(c.pieceId);
      if (!p) continue;
      const g = pieceGeometry(p).connectors[c.index].gender;
      connectorShape(ctx, c, g);
      ctx.fill();
      const m = pegCentre(c, g);
      ctx.beginPath();
      ctx.arc(m.x, m.y, PEG_R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = NEAR_MISS;
  ctx.lineWidth = Math.max(0.03, 2.5 * px);
  for (const [a, b] of doc.graph.nearMisses) {
    ctx.beginPath();
    ctx.arc((a.pos.x + b.pos.x) / 2, (a.pos.y + b.pos.y) / 2, NEAR_MISS_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (overlay.flashRing) {
    ctx.strokeStyle = FLASH;
    ctx.beginPath();
    ctx.arc(overlay.flashRing.x, overlay.flashRing.y, NEAR_MISS_R, 0, Math.PI * 2);
    ctx.stroke();
  }

  const overlapping = new Set(doc.graph.overlaps.flat());
  for (const id of overlapping) {
    const p = doc.piece(id);
    if (p) fillPolys(ctx, worldFootprint(p), OVERLAP);
  }

  ctx.strokeStyle = SELECT;
  ctx.lineWidth = 2 * px;
  ctx.lineJoin = 'round';
  for (const id of overlay.selectedPieces) {
    const p = doc.piece(id);
    if (!p) continue;
    ctx.beginPath();
    tracePolys(ctx, worldFootprint(p));
    ctx.stroke();
  }
  // Resize handles: small squares on the open ends of selected flex pieces.
  ctx.fillStyle = '#ffffff';
  const hs = 5 * px;
  for (const c of doc.graph.open) {
    const p = overlay.selectedPieces.has(c.pieceId) ? doc.piece(c.pieceId) : undefined;
    if (!p || !getPieceDef(p.type).flex) continue;
    ctx.beginPath();
    ctx.rect(c.pos.x - hs, c.pos.y - hs, 2 * hs, 2 * hs);
    ctx.fill();
    ctx.stroke();
  }
  if (overlay.selectedTrain) {
    const t = doc.train(overlay.selectedTrain);
    const cars = !t ? [] : t.head !== null ? (placed.find((x) => x.train === t)?.cars ?? []) : t.lifted ? liftedCarPoses(t.lifted, t.cars) : [];
    outlineCars(ctx, cars);
  }

  for (const t of trains) if (t.head !== null && t.crashed && t.crashAt) crashStar(ctx, t.crashAt, px);

  if (overlay.ghost) {
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    style.piece(ctx, overlay.ghost.piece, { ghost: true });
    ctx.restore();
    if (!overlay.ghost.valid) {
      ctx.save();
      ctx.globalAlpha = GHOST_ALPHA;
      fillPolys(ctx, worldFootprint(overlay.ghost.piece), INVALID);
      ctx.restore();
    }
  }
  if (overlay.ghostTrain) {
    for (const c of overlay.ghostTrain) {
      ctx.save();
      ctx.globalAlpha = GHOST_ALPHA;
      style.car(ctx, c, overlay.ghostTrainValid === false ? INVALID_GHOST_TRAIN : GHOST_TRAIN);
      ctx.restore();
    }
  }
  if (overlay.sketch) drawSketch(ctx, style, overlay.sketch, px);
  ctx.restore();

  ctx.restore();
}

function strokeLine(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.stroke();
}

/**
 * Sketch overlay, in order: the stroke (red from `redFrom`), the ghost at 50% alpha, the lead dot
 * with a ↑ / ↓ badge for a pending ramp, switch outlines, and a red ✕ where a start was refused.
 */
function drawSketch(ctx: CanvasRenderingContext2D, style: Style, s: SketchOverlay, px: number): void {
  ctx.save();
  ctx.lineWidth = 2 * px;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const red = s.redFrom === null ? s.points.length : Math.max(0, Math.min(s.points.length, s.redFrom));
  ctx.strokeStyle = STROKE;
  strokeLine(ctx, s.points.slice(0, red + 1));
  ctx.strokeStyle = STROKE_RED;
  strokeLine(ctx, s.points.slice(Math.max(0, red - 1)));
  ctx.restore();

  for (const p of [...s.ghost].sort((a, b) => a.level - b.level)) {
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    style.piece(ctx, p, { ghost: true });
    ctx.restore();
  }

  if (s.lead) {
    ctx.save();
    ctx.fillStyle = LEAD;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.arc(s.lead.x, s.lead.y, 4 * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (s.pendingRamp !== 0) {
      const bx = s.lead.x + 12 * px, by = s.lead.y - 12 * px;
      ctx.beginPath();
      ctx.arc(bx, by, 8 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${12 * px}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.pendingRamp > 0 ? '↑' : '↓', bx, by + 0.5 * px);
    }
    ctx.restore();
  }

  if (s.switchPreview?.length) {
    ctx.save();
    ctx.strokeStyle = LEAD;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([5 * px, 3 * px]);
    for (const p of s.switchPreview) {
      ctx.beginPath();
      tracePolys(ctx, worldFootprint(p));
      ctx.stroke();
    }
    ctx.restore();
  }

  if (s.refusedAt) {
    const { x, y } = s.refusedAt, r = 7 * px;
    ctx.save();
    ctx.strokeStyle = REFUSED;
    ctx.lineWidth = 3 * px;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.restore();
  }
}
