/**
 * StrokeFitter: the live ghost of a sketch stroke (spec §5.3, §5.5, §5.8). Pure: it reads the doc
 * and never changes it.
 *
 * Contract for the release step (Task 9):
 * - `pieces` is the ghost in stroke order. Every piece is entered at connector 0 and left at 1,
 *   except a `ramp-2` laid going down, which is entered at 1 and left at 0. `anchors[i]` is the
 *   outward pose piece i was attached to (where it is entered), so dropping trailing pieces k..
 *   leaves the lead at `anchors[k]`. `lead` is the outward pose of the ghost's leading end.
 * - `crossings[c]` is one crossover the stroke passes through. The crossover sits between
 *   `pieces[index - 1]` (or the stroke start, for index 0), which ends at the crossover's entry,
 *   and `pieces[index]` (or the lead, when index === pieces.length), which starts at its exit.
 *   Pieces before such an index are never reworked again by the fitter.
 *   - `ghost: false` (existing track): `splice` must be applied to the doc. Its `remove` ids are doc
 *     piece ids, or ids `crossId(c2, i)` naming `crossings[c2].splice.add[i]` of an EARLIER crossing
 *     c2 < c (a stroke crossing the same run twice). Apply the splices in order, remembering the id
 *     given to each added piece. `splice.add` holds the crossover itself and the refill straights.
 *   - `ghost: true` (the stroke crossed its own earlier ghost): the fitter has already replaced
 *     the crossed ghost straights inside `pieces` with refill straights plus the crossover, and
 *     `pieces[index]` IS that crossover (not in the chain order above: the stroke passes through
 *     its other route). The refill straights around it are laid along the crossed run, which may
 *     be against stroke order (mergeStraights copes with either orientation); their `anchors` are
 *     simply their connector 0. `splice` is empty ({ remove: [], add: [] }): nothing to apply.
 *     Indices (of `crossings` and of later pieces) shift when such a replacement changes the count.
 * - `redFrom` is set when the next piece would cross track that is not plain straight (or a
 *   crossover could not be fitted). Nothing more is appended; the ghost is good up to the lead.
 */
import { type Pose, type Vec2, angleDiff, dist, fromAngle, normDeg, sub } from '../geom/vec';
import { samplePath, transformPath } from '../geom/path';
import { Doc } from '../model/doc';
import { MAX_LEVEL } from '../model/types';
import { pieceGeometry } from '../track/catalog';
import { JOIN_POS_TOL, OVERLAP_CLEARANCE } from '../track/graph';
import { solveJoin } from './join';
import { type PieceSpec, attachSpec, outPose, specToPiece } from './spec';
import { type Splice, crossingSplice } from './splice';

/** Append a piece once the stroke is this far past the lead (along the stroke). */
export const STEP_DIST = 0.75;
/** Candidates are scored against the stroke point this far ahead of the lead. */
export const LOOKAHEAD = 1.0;
/** A start with no heading takes the drag direction once the pointer is this far from the start. */
export const START_DIST = 0.5;

/** Score weight per degree between a candidate's end heading and the stroke's heading at the target. */
export const W_HEADING = 0.01;
/** Score weight per degree a candidate turns: a small bias against zig-zags. */
export const W_TURN = 0.001;
/** Score weight per U a candidate falls short of the lookahead: prefers longer pieces (fewer clicks). */
export const W_SHORT = 0.05;
/** Half-width of the stroke window over which a stroke heading is measured. */
export const TANGENT_WINDOW = 0.3;
/** A pending ramp needs the stroke to stay within this of the lead's line for the ramp's length. */
export const RAMP_TOL = 0.3;
const RAMP_LEN = 2;
/** With every candidate blocked by nearby track the stroke never crosses, give up (red) past this lead. */
const BLOCKED_LIMIT = 2 * LOOKAHEAD + 0.5;
/** A crossing join turning more than this in total is rejected as a loop. */
const MAX_JOIN_TURN = 120;
/** After a piece, the lead's stroke position advances by at least this fraction of its length. */
const MIN_ADVANCE = 0.25;
const MAX_STEPS = 1000;
const EPS = 1e-9;

export interface Candidate { type: string; flipped: boolean }
const both = (type: string): Candidate[] => [{ type, flipped: false }, { type, flipped: true }];

export const FREEHAND_SET: readonly Candidate[] = [
  { type: 'straight-1-4', flipped: false }, { type: 'straight-1-2', flipped: false }, { type: 'straight-1', flipped: false },
  ...both('curve-l-22'), ...both('curve-s-45'), ...both('curve-m-45'), ...both('curve-l-45'),
];
export const SHIFT_SET: readonly Candidate[] = [{ type: 'straight-1', flipped: false }, ...both('curve-m-45'), ...both('curve-l-45')];
/** Added to the Shift set while the heading is off the 8 compass directions. */
const SHIFT_BEND: readonly Candidate[] = both('curve-l-22');

export interface FitterStart { pos: Vec2; heading: number | null; level: number }
export interface FitterCrossing { index: number; splice: Splice; ghost: boolean; type: 'crossover-90' | 'crossover-45' }

/** Id of `crossings[c].splice.add[i]` when a later crossing's splice removes it. */
export const crossId = (c: number, i: number): string => 'cross:' + c + ':' + i;
const ghostId = (i: number): string => 'ghost:' + i;

const isStraight = (type: string): boolean => type.startsWith('straight-');
const on45 = (deg: number): boolean => Math.abs(deg / 45 - Math.round(deg / 45)) < 1e-6;
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

// ---- route polylines and proximity ----

interface Shape { lines: Vec2[][]; box: [number, number, number, number] }
/** Cached per spec object, checked against its pose so a piece changed in place is re-sampled. */
const shapeCache = new WeakMap<object, { key: string; shape: Shape }>();
const poseKey = (p: PieceSpec): string =>
  [p.type, p.x, p.y, p.rot, p.flipped, p.flex ? JSON.stringify(p.flex) : ''].join('|');

/** Route centrelines sampled every <= 1/16U and <= 5° (as the overlap check in graph.ts). */
function shapeOf(p: PieceSpec): Shape {
  const key = poseKey(p);
  const hit = shapeCache.get(p);
  if (hit && hit.key === key) return hit.shape;
  const lines: Vec2[][] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of pieceGeometry(p).routes) {
    const path = transformPath(r.path, p);
    const turn = path.segments.reduce((t, g) => t + (g.kind === 'arc' ? Math.abs(g.sweep) : 0), 0);
    const n = Math.max(1, Math.ceil(path.length * 16), Math.ceil(turn / 5));
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const v = samplePath(path, (path.length * i) / n).pos;
      pts.push(v);
      x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y);
    }
    lines.push(pts);
  }
  const shape: Shape = { lines, box: [x0, y0, x1, y1] };
  shapeCache.set(p, { key, shape });
  return shape;
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Parameters (t along a→b, u along c→d) where two segments cross, or null. */
function segCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c), den = cross2(r, s);
  if (Math.abs(den) < EPS) return null;
  const ac = sub(c, a);
  const t = cross2(ac, s) / den, u = cross2(ac, r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segCross(a, b, c, d)) return 0;
  return Math.min(distToSeg(a, c, d), distToSeg(b, c, d), distToSeg(c, a, b), distToSeg(d, a, b));
}

/** True when any route of `a` comes within OVERLAP_CLEARANCE of any route of `b`. */
function near(a: Shape, b: Shape): boolean {
  const m = OVERLAP_CLEARANCE;
  if (a.box[0] > b.box[2] + m || b.box[0] > a.box[2] + m || a.box[1] > b.box[3] + m || b.box[1] > a.box[3] + m) return false;
  for (const la of a.lines) for (const lb of b.lines) {
    for (let i = 0; i + 1 < la.length; i++) for (let j = 0; j + 1 < lb.length; j++) {
      if (segSegDist(la[i], la[i + 1], lb[j], lb[j + 1]) < m) return true;
    }
  }
  return false;
}

/** Same-level track a candidate is checked against: existing (effective) doc pieces or earlier ghost pieces. */
interface Obstacle { id: string; spec: PieceSpec; ghost: number | null }

const connectorsOf = (p: PieceSpec): Vec2[] => pieceGeometry(p).connectors.map((_, i) => outPose(p, i));
const hasConnectorAt = (p: PieceSpec, at: Vec2): boolean => connectorsOf(p).some((c) => dist(c, at) < JOIN_POS_TOL);

/** Total absolute turn of a chain, in degrees. */
const chainTurn = (chain: PieceSpec[]): number => chain.reduce((t, s) => {
  const g = pieceGeometry(s);
  return t + g.routes[0].path.segments.reduce((u, seg) => u + (seg.kind === 'arc' ? Math.abs(seg.sweep) : 0), 0);
}, 0);

export class StrokeFitter {
  readonly points: Vec2[] = [];
  readonly pieces: PieceSpec[] = [];
  /** The outward pose each piece of `pieces` attaches to (see the contract above). */
  readonly anchors: Pose[] = [];
  readonly crossings: FitterCrossing[] = [];

  private readonly doc: Doc;
  /** The doc with this stroke's existing-track crossing splices applied (ids per `crossId`). */
  private world: Doc;
  private readonly cum: number[] = [];
  private heading: number | null;
  private _lead: { pose: Pose; level: number };
  private _pendingRamp: -1 | 0 | 1 = 0;
  private _redFrom: number | null = null;
  /** Stroke position (arc length) the lead corresponds to. */
  private leadS = 0;
  /** Stroke position of each piece's anchor, parallel to `pieces`. */
  private readonly anchorS: number[] = [];
  /** pieces[0..fixed) are never reworked by a crossing join (behind a ramp or an earlier crossing). */
  private fixed = 0;
  private readonly startPose: Pose;

  constructor(doc: Doc, start: FitterStart) {
    this.doc = doc;
    this.world = doc;
    this.heading = start.heading;
    this.startPose = { x: start.pos.x, y: start.pos.y, rot: start.heading ?? 0 };
    this._lead = { pose: { ...this.startPose }, level: start.level };
    this.points.push({ x: start.pos.x, y: start.pos.y });
    this.cum.push(0);
  }

  get lead(): { pose: Pose; level: number } { return this._lead; }
  get pendingRamp(): -1 | 0 | 1 { return this._pendingRamp; }
  get redFrom(): number | null { return this._redFrom; }
  get length(): number { return this.cum[this.cum.length - 1]; }

  /**
   * Request a ramp up (+1) or down (−1) at the next 2U straight stretch. `pendingRamp` is the net
   * requested change: the opposite key cancels a pending ramp; pressing the same key again, or a
   * ramp that would take the level out of 0..MAX_LEVEL, returns false and changes nothing.
   */
  requestRamp(dir: 1 | -1): boolean {
    const next = this._pendingRamp + dir;
    if (next < -1 || next > 1) return false;
    const level = this._lead.level + next;
    if (level < 0 || level > MAX_LEVEL) return false;
    this._pendingRamp = next as -1 | 0 | 1;
    return true;
  }

  /** Add a stroke point; returns the number of pieces appended (each one a click). */
  addPoint(p: Vec2, shift: boolean): number {
    const last = this.points[this.points.length - 1];
    const d = dist(last, p);
    if (d < EPS) return 0;
    this.points.push({ x: p.x, y: p.y });
    this.cum.push(this.length + d);
    if (this._redFrom !== null) return 0;
    if (this.heading === null) {
      const v = sub(p, this.startPose);
      if (Math.hypot(v.x, v.y) < START_DIST) return 0;
      const q = shift ? 45 : 22.5;
      this.heading = normDeg(Math.round((Math.atan2(v.y, v.x) * 180) / Math.PI / q) * q);
      this.startPose.rot = this.heading;
      this._lead = { pose: { ...this.startPose }, level: this._lead.level };
    }
    let added = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
      const n = this.step(shift);
      if (n === null) break;
      added += n;
    }
    return added;
  }

  // ---- stroke geometry ----

  private strokeAt(s: number): Vec2 {
    const { cum, points } = this;
    if (s <= 0) return points[0];
    if (s >= this.length) return points[points.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const f = (s - cum[lo]) / (cum[hi] - cum[lo]);
    return { x: points[lo].x + (points[hi].x - points[lo].x) * f, y: points[lo].y + (points[hi].y - points[lo].y) * f };
  }

  /** Stroke heading (degrees) around position s, or `fallback` where the stroke has no extent. */
  private strokeHeading(s: number, fallback: number): number {
    const a = this.strokeAt(Math.max(0, s - TANGENT_WINDOW)), b = this.strokeAt(Math.min(this.length, s + TANGENT_WINDOW));
    const v = sub(b, a);
    return Math.hypot(v.x, v.y) < EPS ? fallback : (Math.atan2(v.y, v.x) * 180) / Math.PI;
  }

  /**
   * Stroke position of the point nearest `p` among stroke positions [s0, s1]; beyond the stroke's
   * end it continues along the last stroke heading, so a lead ahead of the pointer is not undercounted.
   */
  private project(p: Vec2, s0: number, s1: number): number {
    const { cum, points } = this;
    let best = s0, bestD = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      if (cum[i + 1] < s0 || cum[i] > s1) continue;
      const a = points[i], b = points[i + 1], l = cum[i + 1] - cum[i];
      if (l < EPS) continue;
      const t = Math.max(0, Math.min(1, dot(sub(p, a), sub(b, a)) / (l * l)));
      const s = Math.max(s0, Math.min(s1, cum[i] + t * l));
      const d = dist(p, this.strokeAt(s));
      if (d < bestD - EPS) { bestD = d; best = s; }
    }
    // Past the end of the stroke: count how far beyond it `p` lies along the stroke's last heading.
    if (best >= this.length - EPS) {
      const u = fromAngle(this.strokeHeading(this.length, 0));
      best = this.length + Math.max(0, dot(sub(p, this.strokeAt(this.length)), u));
    }
    return best;
  }

  /** First place (by stroke position, within [s0, s1]) where the stroke crosses a route of `spec`. */
  private strokeCrossing(spec: PieceSpec, s0: number, s1: number): { s: number; at: Vec2 } | null {
    const { cum, points } = this;
    const shape = shapeOf(spec);
    let best: { s: number; at: Vec2 } | null = null;
    for (let i = 0; i + 1 < points.length; i++) {
      if (cum[i + 1] < s0 || cum[i] > s1) continue;
      for (const line of shape.lines) for (let j = 0; j + 1 < line.length; j++) {
        const x = segCross(points[i], points[i + 1], line[j], line[j + 1]);
        if (!x) continue;
        const s = cum[i] + x.t * (cum[i + 1] - cum[i]);
        if (s < s0 || s > s1 || (best && s >= best.s)) continue;
        best = { s, at: { x: points[i].x + (points[i + 1].x - points[i].x) * x.t, y: points[i].y + (points[i + 1].y - points[i].y) * x.t } };
      }
    }
    return best;
  }

  // ---- obstacles ----

  /** Same-level track the next piece must not touch, minus the track it legitimately joins. */
  private obstacles(): Obstacle[] {
    const level = this._lead.level, n = this.pieces.length;
    const all: Obstacle[] = [];
    for (const p of this.world.layout.pieces) if (p.level === level) all.push({ id: p.id, spec: p, ghost: null });
    for (let i = 0; i < n - 2; i++) if (this.pieces[i].level === level) all.push({ id: ghostId(i), spec: this.pieces[i], ghost: i });
    // Track joined at the lead (the start piece, a crossover being left) and its neighbours, and
    // track joined where the last ghost piece starts, touch the next piece without crossing it.
    const lead = this._lead.pose;
    const attached = all.filter((o) => hasConnectorAt(o.spec, lead));
    const ends = attached.flatMap((o) => connectorsOf(o.spec));
    const prev = n > 0 ? this.anchors[n - 1] : null;
    return all.filter((o) => !attached.includes(o)
      && !ends.some((e) => hasConnectorAt(o.spec, e))
      && !(prev && hasConnectorAt(o.spec, prev)));
  }

  // ---- stepping ----

  private candidates(shift: boolean): readonly Candidate[] {
    const h = this._lead.pose.rot;
    let set: readonly Candidate[] = shift ? (on45(h) ? SHIFT_SET : [...SHIFT_SET, ...SHIFT_BEND]) : FREEHAND_SET;
    if (this._pendingRamp !== 0) set = set.filter((c) => isStraight(c.type));
    if (shift) {
      const kept = set.filter((c) => on45(outPose(this.attach(c), 1).rot));
      // From a heading no Shift piece can bring back onto the 8 directions, allow the whole set.
      if (kept.length) set = kept;
    }
    return set;
  }

  private attach(c: Candidate): PieceSpec {
    return attachSpec(c.type, c.flipped, undefined, this._lead.pose, this._lead.level);
  }

  /** Lower is better: miss distance at the lookahead point, heading error, turn, shortness. */
  private score(spec: PieceSpec, la: number, target: Vec2, targetHeading: number): number {
    const end = outPose(spec, 1);
    const len = pieceGeometry(spec).routes[0].path.length;
    const u = fromAngle(end.rot);
    const p = { x: end.x + u.x * (la - len), y: end.y + u.y * (la - len) };
    return dist(p, target) + W_HEADING * angleDiff(end.rot, targetHeading)
      + W_TURN * angleDiff(end.rot, this._lead.pose.rot) + W_SHORT * Math.max(0, la - len);
  }

  /** One step: append a piece, a ramp or a crossing; null when nothing more can be appended now. */
  private step(shift: boolean): number | null {
    if (this._redFrom !== null) return null;
    if (this._pendingRamp !== 0) {
      const r = this.tryRamp();
      if (r === 'placed') return 1;
      if (r === 'wait') return null;
    }
    const avail = this.length - this.leadS;
    if (avail <= STEP_DIST) return null;
    const la = Math.min(LOOKAHEAD, avail);
    const sT = this.leadS + la;
    const target = this.strokeAt(sT), th = this.strokeHeading(sT, this._lead.pose.rot);
    const ranked = this.candidates(shift)
      .map((c, i) => { const spec = this.attach(c); return { spec, i, score: this.score(spec, la, target, th) }; })
      .sort((a, b) => a.score - b.score || a.i - b.i);
    const obstacles = this.obstacles();
    for (const { spec } of ranked) {
      const shape = shapeOf(spec);
      const touched = obstacles.filter((o) => near(shape, shapeOf(o.spec)));
      if (touched.length === 0) { this.append(spec); return 1; }
      // Touching track: a crossing when the stroke actually crosses it nearby, else try the next candidate.
      let hit: { o: Obstacle; s: number; at: Vec2 } | null = null;
      for (const o of touched) {
        const x = this.strokeCrossing(o.spec, this.leadS - OVERLAP_CLEARANCE, this.leadS + LOOKAHEAD + 1.5);
        if (x && (!hit || x.s < hit.s)) hit = { o, ...x };
      }
      if (hit) return this.cross(hit.o, hit.at, this.strokeHeading(hit.s, this._lead.pose.rot), hit.s);
    }
    // Every candidate is blocked by track the stroke runs beside but does not cross.
    if (avail > BLOCKED_LIMIT) return this.red();
    return null;
  }

  private append(spec: PieceSpec, exit = 1): void {
    const len = pieceGeometry(spec).routes[0].path.length;
    this.pieces.push(spec);
    this.anchors.push({ ...this._lead.pose });
    this.anchorS.push(this.leadS);
    const end = outPose(spec, exit);
    const level = spec.level + pieceGeometry(spec).connectors[exit].levelOffset;
    const s = this.project(end, this.leadS - 0.25, this.leadS + len + LOOKAHEAD);
    this.leadS = Math.max(s, this.leadS + MIN_ADVANCE * len);
    this._lead = { pose: end, level };
  }

  /** Place a pending ramp once the stroke runs 2U straight on from the lead. */
  private tryRamp(): 'placed' | 'wait' | 'no' {
    const lead = this._lead.pose, u = fromAngle(lead.rot);
    const offset = (s: number): number => cross2(u, sub(this.strokeAt(s), lead));
    const o0 = offset(this.leadS);
    const end = Math.min(this.length, this.leadS + RAMP_LEN);
    for (let s = this.leadS; s <= end + EPS; s += 0.1) {
      if (Math.abs(offset(Math.min(s, end)) - o0) > RAMP_TOL) return 'no';
    }
    if (this.length - this.leadS < RAMP_LEN) return 'wait';
    const up = this._pendingRamp > 0;
    const spec = up
      ? attachSpec('ramp-2', false, undefined, lead, this._lead.level, 0)
      : attachSpec('ramp-2', false, undefined, lead, this._lead.level - 1, 1);
    const shape = shapeOf(spec);
    if (this.obstacles().some((o) => near(shape, shapeOf(o.spec)))) return 'no';
    this.append(spec, up ? 1 : 0);
    this._pendingRamp = 0;
    this.fixed = this.pieces.length;
    return 'placed';
  }

  /** The stroke turns red from the lead onward. */
  private red(): null {
    const i = this.cum.findIndex((c) => c >= this.leadS - EPS);
    this._redFrom = i < 0 ? this.points.length - 1 : i;
    return null;
  }

  /**
   * Re-join the ghost to `entry`, reworking up to two trailing pieces (not behind `fixed`): the
   * number of pieces dropped and the joining chain, or null.
   */
  private joinTo(entry: Pose): { drop: number; chain: PieceSpec[] } | null {
    const n = this.pieces.length;
    for (let k = 0; k <= 2 && n - k >= this.fixed; k++) {
      const from = k === 0 ? this._lead.pose : this.anchors[n - k];
      if (dist(from, entry) < JOIN_POS_TOL && angleDiff(from.rot, entry.rot + 180) < 1) return { drop: k, chain: [] };
      const chain = solveJoin(from, entry, this._lead.level);
      if (chain && chainTurn(chain) <= MAX_JOIN_TURN) return { drop: k, chain };
    }
    return null;
  }

  /** Insert a crossover where the stroke crosses obstacle `o`, re-join to it and continue past it. */
  private cross(o: Obstacle, at: Vec2, heading: number, sCross: number): number | null {
    const level = this._lead.level;
    const ghostDoc = (): Doc => new Doc({
      ...this.doc.layout,
      pieces: this.pieces.slice(0, this.pieces.length - 2).flatMap((s, i) => (s.level === level ? [specToPiece(s, ghostId(i))] : [])),
    });
    const res = crossingSplice(o.ghost === null ? this.world : ghostDoc(), o.id, at, heading);
    if (!res) return this.red();
    let range: [number, number] | null = null;
    if (o.ghost !== null) {
      const idx = res.splice.remove.map((id) => Number(id.slice('ghost:'.length))).sort((a, b) => a - b);
      if (idx.some((v, i) => v !== idx[0] + i)) return this.red();
      range = [idx[0], idx[idx.length - 1]];
    }
    const join = this.joinTo(res.entry);
    if (!join) return this.red();

    // Rework the trailing pieces and join the entry.
    const keep = this.pieces.length - join.drop;
    this.leadS = keep < this.pieces.length ? this.anchorS[keep] : this.leadS;
    this._lead = { pose: keep < this.pieces.length ? this.anchors[keep] : this._lead.pose, level };
    this.pieces.length = keep; this.anchors.length = keep; this.anchorS.length = keep;
    for (const s of join.chain) this.append(s);

    if (range) {
      // Replace the crossed ghost straights in place; later indices shift by `delta`.
      const [lo, hi] = range;
      const add = res.splice.add;
      const delta = add.length - (hi - lo + 1);
      const sAt = this.anchorS[lo];
      this.pieces.splice(lo, hi - lo + 1, ...add);
      this.anchors.splice(lo, hi - lo + 1, ...add.map((s) => { const c = outPose(s, 0); return { x: c.x, y: c.y, rot: normDeg(c.rot + 180) }; }));
      this.anchorS.splice(lo, hi - lo + 1, ...add.map(() => sAt));
      for (const c of this.crossings) if (c.index > hi) c.index += delta;
      const xi = lo + add.findIndex((s) => s.type === res.type);
      this.crossings.push({ index: xi, splice: { remove: [], add: [] }, ghost: true, type: res.type });
    } else {
      const c = this.crossings.length;
      this.crossings.push({ index: this.pieces.length, splice: res.splice, ghost: false, type: res.type });
      const removed = new Set(res.splice.remove);
      this.world = new Doc({
        ...this.doc.layout,
        pieces: [
          ...this.world.layout.pieces.filter((p) => !removed.has(p.id)),
          ...res.splice.add.map((s, i) => specToPiece(s, crossId(c, i))),
        ],
      });
    }

    // Continue from the crossover's far connector.
    this._lead = { pose: res.exit, level };
    this.leadS = Math.max(sCross, this.project(res.exit, sCross - 0.5, sCross + LOOKAHEAD + 1.5));
    this.fixed = this.pieces.length;
    return join.chain.length + 1;
  }
}
