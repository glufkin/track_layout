/**
 * StrokeFitter: the live ghost of a sketch stroke (spec §5.3, §5.5, §5.8). Pure: it reads the doc
 * and never changes it.
 *
 * Contract for the release step (Task 9):
 * - `pieces` is the ghost in stroke order. Every piece is entered at connector 0 and left at 1,
 *   except a `ramp-2` laid going down, which is entered at 1 and left at 0. `anchors[i]` is the
 *   outward pose piece i was attached to (where it is entered), so dropping trailing pieces k..
 *   leaves the lead at `anchors[k]`. `lead` is the outward pose of the ghost's leading end.
 * - `frozen`: pieces[0..frozen) are fixed (ramps, crossovers, the pieces mating a crossover's
 *   entry, and everything before them). Release may only drop or rework pieces[frozen..]. When a
 *   crossing's join chain is empty, the last piece mates the crossover entry and is frozen too.
 * - `crossings[c]` is one crossover the stroke passes through. `through` is where the stroke passes
 *   it: `pieces[through - 1]` (or the stroke start, for 0) ends at the crossover's entry, and
 *   `pieces[through]` (or the lead, when through === pieces.length) starts at its exit.
 *   `frozen >= through` for every crossing. `index` is where the crossover piece itself is:
 *   - `ghost: false` (existing track): `index === through`; the crossover is not in `pieces` but in
 *     `splice.add`, with the refill straights, and `splice` must be applied to the doc. Its `remove`
 *     ids are doc piece ids, or ids `crossId(c2, i)` naming `crossings[c2].splice.add[i]` of an
 *     EARLIER crossing c2 < c (a stroke crossing the same run twice). Apply the splices in order,
 *     remembering the id given to each added piece.
 *   - `ghost: true` (the stroke crossed its own earlier ghost): the fitter has already replaced
 *     the crossed ghost straights inside `pieces` with refill straights plus the crossover, and
 *     `pieces[index]` IS that crossover (index < through; it is not in the chain order above).
 *     The refill straights around it are laid along the crossed run, which may be against stroke
 *     order (mergeStraights copes with either orientation); their `anchors` are simply their
 *     connector 0. `splice` is empty ({ remove: [], add: [] }): nothing to apply. `index` and
 *     `through` of every crossing (and later pieces) shift when such a replacement changes the count.
 * - Pending ramp: any candidate may be laid while the stroke bends; `ramp-2` is appended as soon as
 *   the stroke ahead of the lead offers 2U of straight run.
 * - The ghost never outruns or wanders off the stroke. A piece is skipped when it would end more
 *   than MAX_OFF from the rest of the stroke, or more than FOLLOW_LIMIT from it without progressing
 *   along it or turning toward the stroke's heading (swinging round a corner is allowed). No piece
 *   is laid while the ghost is LENGTH_SLACK longer than the stroke; at most 64 pieces per point.
 * - A stall always resolves: while no piece can be laid, `leadS` is re-anchored to the latest
 *   stroke point nearest the lead (within 1.5U), and once BLOCKED_LIMIT (2.5U) of stroke has been
 *   drawn since the last piece, `redFrom` is set. A ghost crossing that would rework pieces below
 *   `frozen` also turns the stroke red.
 * - `redFrom` is set when the next piece would cross track that is not plain straight (or a
 *   crossover could not be fitted). Nothing more is appended; the ghost is good up to the lead.
 */
import { type Pose, type Vec2, angleDiff, dist, fromAngle, normDeg, sub } from '../geom/vec';
import { Doc } from '../model/doc';
import { MAX_LEVEL, type Piece } from '../model/types';
import { pieceGeometry } from '../track/catalog';
import { JOIN_POS_TOL, OVERLAP_CLEARANCE, type RouteShape, buildGraph, distToSeg, routeShape, shapesNear } from '../track/graph';
import { chainTurn, gentlest, solveJoin } from './join';
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
/** Distance beyond the target point the heading term aims at (pure pursuit). */
export const PURSUIT = 1.5;
/** Score weight per degree a candidate turns: a small bias against zig-zags. */
export const W_TURN = 0.001;
/** Score weight per U a candidate falls short of the lookahead: prefers longer pieces (fewer clicks). */
export const W_SHORT = 0.05;
/** Half-width of the stroke window over which a stroke heading is measured. */
export const TANGENT_WINDOW = 0.3;
/** A pending ramp needs the stroke to stay within this of the lead's line for the ramp's length. */
export const RAMP_TOL = 0.3;
const RAMP_LEN = 2;
/** A ghost that has appended nothing while this much new stroke was drawn gives up (red). */
const BLOCKED_LIMIT = 2 * LOOKAHEAD + 0.5;
/**
 * The ghost may be this much longer than the stroke (plus the piece being laid): swinging wide round
 * a sharp corner or hairpin needs more track than the stroke drew there.
 */
const LENGTH_SLACK = 3;
/**
 * No piece ever ends farther than this from the rest of the stroke: room to swing round a 135°
 * corner with medium curves (about 2U) but no further, so the ghost cannot wander off.
 */
export const MAX_OFF = 2.5;
/** A far, non-progressing piece is still laid if it cuts the heading error by more than this (degrees). */
const TURN_TOWARD = 1;
/** A waiting ghost re-anchors to the latest stroke point within this of the lead. */
const REANCHOR_DIST = 1.5;
/** Stroke points this much farther from the lead than the nearest one still count as nearest. */
const REANCHOR_SLACK = 0.05;
/** A crossing join turning more than this in total is rejected as a loop. */
const MAX_JOIN_TURN = 120;
/** After a piece, the lead's stroke position advances by at least this fraction of its length. */
const MIN_ADVANCE = 0.25;
/** Pieces appended per `addPoint` at most; the rest follows on later points. */
const MAX_STEPS = 64;
/** Wait (append nothing) while the best piece would end farther than this from the stroke without progressing along it. */
export const FOLLOW_LIMIT = 0.75;
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
export interface FitterCrossing {
  index: number; through: number; splice: Splice; ghost: boolean; type: 'crossover-90' | 'crossover-45';
}

/** Id of `crossings[c].splice.add[i]` when a later crossing's splice removes it. */
export const crossId = (c: number, i: number): string => 'cross:' + c + ':' + i;
const ghostId = (i: number): string => 'ghost:' + i;

const on45 = (deg: number): boolean => Math.abs(deg / 45 - Math.round(deg / 45)) < 1e-6;
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

// ---- route polylines and proximity ----

/** Cached per spec object, checked against its pose so a piece changed in place is re-sampled. */
const shapeCache = new WeakMap<object, { key: string; shape: RouteShape }>();
const poseKey = (p: PieceSpec): string =>
  [p.type, p.x, p.y, p.rot, p.flipped, p.flex ? JSON.stringify(p.flex) : ''].join('|');

function shapeOf(p: PieceSpec): RouteShape {
  const key = poseKey(p);
  const hit = shapeCache.get(p);
  if (hit && hit.key === key) return hit.shape;
  const shape = routeShape(p);
  shapeCache.set(p, { key, shape });
  return shape;
}

/** Parameters (t along a→b, u along c→d) where two segments cross, or null. */
function segCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c), den = cross2(r, s);
  if (Math.abs(den) < EPS) return null;
  const ac = sub(c, a);
  const t = cross2(ac, s) / den, u = cross2(ac, r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

/** Same-level track a candidate is checked against: existing (effective) doc pieces or earlier ghost pieces. */
interface Obstacle { id: string; spec: PieceSpec; ghost: number | null }

const connectorsOf = (p: PieceSpec): Vec2[] => pieceGeometry(p).connectors.map((_, i) => outPose(p, i));
const hasConnectorAt = (p: PieceSpec, at: Vec2): boolean => connectorsOf(p).some((c) => dist(c, at) < JOIN_POS_TOL);

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
  /** pieces[0..fixed) are fixed: ramps, crossings, the pieces mating them and everything before. */
  private fixed = 0;
  /** Stroke length when the ghost last appended (or its heading was fixed). */
  private progressAt = 0;
  /** Total route length of the stroke-order ghost (crossovers passed counted by their crossing route). */
  private ghostLen = 0;
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
  /** pieces[0..frozen) are fixed; release may only drop or rework pieces[frozen..]. */
  get frozen(): number { return this.fixed; }

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
      this.progressAt = this.length;
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

  /**
   * True when appending `spec` would leave the stroke behind: its end lies more than FOLLOW_LIMIT
   * from the stroke and makes (almost) no progress along it, as when the stroke doubles back or
   * turns away tighter than any piece can, unless it turns the lead toward the stroke's heading at
   * the target (`targetHeading`): swinging wide round a sharp corner or a hairpin is following.
   * A piece ending more than MAX_OFF from the rest of the stroke is never laid.
   */
  private cannotFollow(spec: PieceSpec, targetHeading: number): boolean {
    const end = outPose(spec, 1);
    if (this.strokeDist(end, this.leadS - 1) > MAX_OFF) return true;
    const len = pieceGeometry(spec).routes[0].path.length;
    const s = this.project(end, this.leadS - 0.25, this.leadS + len + LOOKAHEAD);
    let off: number;
    if (s < this.length - EPS) off = dist(end, this.strokeAt(s));
    else off = Math.abs(cross2(fromAngle(this.strokeHeading(this.length, 0)), sub(end, this.strokeAt(this.length))));
    if (off <= FOLLOW_LIMIT || s - this.leadS >= MIN_ADVANCE * len) return false;
    return angleDiff(end.rot, targetHeading) >= angleDiff(this._lead.pose.rot, targetHeading) - TURN_TOWARD;
  }

  /** Distance from `p` to the stroke from position s0 to its end. */
  private strokeDist(p: Vec2, s0: number): number {
    const { cum, points } = this;
    let d = dist(p, points[points.length - 1]);
    for (let i = 0; i + 1 < points.length; i++) {
      if (cum[i + 1] < s0) continue;
      d = Math.min(d, distToSeg(p, points[i], points[i + 1]));
    }
    return d;
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
    // Pure pursuit: aim at a point PURSUIT beyond the target along the stroke, so a piece off the
    // stroke is scored against a heading that leads back onto it.
    const t = fromAngle(targetHeading);
    const aim = { x: target.x + t.x * PURSUIT - p.x, y: target.y + t.y * PURSUIT - p.y };
    const want = (Math.atan2(aim.y, aim.x) * 180) / Math.PI;
    return dist(p, target) + W_HEADING * angleDiff(end.rot, want)
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
    if (avail <= STEP_DIST || this.ghostLen > this.length + LENGTH_SLACK) return null;
    const la = Math.min(LOOKAHEAD, avail);
    const sT = this.leadS + la;
    const target = this.strokeAt(sT), th = this.strokeHeading(sT, this._lead.pose.rot);
    const ranked = this.candidates(shift)
      .map((c, i) => { const spec = this.attach(c); return { spec, i, score: this.score(spec, la, target, th) }; })
      .sort((a, b) => a.score - b.score || a.i - b.i);
    const obstacles = this.obstacles();
    for (const { spec } of ranked) {
      const shape = shapeOf(spec);
      const touched = obstacles.filter((o) => shapesNear(shape, shapeOf(o.spec)));
      if (touched.length === 0) {
        if (this.cannotFollow(spec, th)) continue;
        this.append(spec);
        return 1;
      }
      // Touching track: a crossing when the stroke actually crosses it nearby, else try the next candidate.
      let hit: { o: Obstacle; s: number; at: Vec2 } | null = null;
      for (const o of touched) {
        const x = this.strokeCrossing(o.spec, this.leadS - OVERLAP_CLEARANCE, this.leadS + LOOKAHEAD + 1.5);
        if (x && (!hit || x.s < hit.s)) hit = { o, ...x };
      }
      if (hit) return this.cross(hit.o, hit.at, this.strokeHeading(hit.s, this._lead.pose.rot), hit.s);
    }
    // No candidate can follow the stroke or get past nearby track: wait, re-anchored.
    return this.stall();
  }

  /**
   * The ghost is waiting with stroke to spare. Re-anchor `leadS` to the latest stroke point (at or
   * after it) nearest the lead, if within REANCHOR_DIST, so the target moves on as the user keeps
   * drawing (round a hairpin, or off a scribble). A ghost that has appended nothing while more than
   * BLOCKED_LIMIT of new stroke was drawn gives up: red.
   */
  private stall(): null {
    if (this.length - this.progressAt > BLOCKED_LIMIT) return this.red();
    const { cum, points } = this, lead = this._lead.pose;
    const near: Array<{ s: number; d: number }> = [];
    for (let i = 0; i + 1 < points.length; i++) {
      if (cum[i + 1] < this.leadS) continue;
      const a = points[i], b = points[i + 1], l = cum[i + 1] - cum[i];
      if (l < EPS) continue;
      const t = Math.max(0, Math.min(1, dot(sub(lead, a), sub(b, a)) / (l * l)));
      const s = Math.max(this.leadS, cum[i] + t * l);
      near.push({ s, d: dist(lead, this.strokeAt(s)) });
    }
    if (near.length === 0) return null;
    const dmin = Math.min(...near.map((n) => n.d));
    if (dmin > REANCHOR_DIST) return null;
    const s = Math.max(...near.filter((n) => n.d <= dmin + REANCHOR_SLACK).map((n) => n.s));
    if (s > this.leadS) this.leadS = s;
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
    this.ghostLen += len;
    this.progressAt = this.length;
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
    if (this.obstacles().some((o) => shapesNear(shape, shapeOf(o.spec)))) return 'no';
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
   * Re-join the ghost to `entry`, reworking up to two trailing pieces (not behind `fixed`): of the
   * rework counts whose chain turns at most MAX_JOIN_TURN and passes `ok` (the overlap check), the
   * gentlest chain; the number of pieces dropped and the chain, or null.
   */
  private joinTo(entry: Pose, ok: (join: { drop: number; chain: PieceSpec[] }) => boolean): { drop: number; chain: PieceSpec[] } | null {
    const n = this.pieces.length;
    const found: Array<{ drop: number; chain: PieceSpec[] }> = [];
    for (let k = 0; k <= 2 && n - k >= this.fixed; k++) {
      const from = k === 0 ? this._lead.pose : this.anchors[n - k];
      const chain = dist(from, entry) < JOIN_POS_TOL && angleDiff(from.rot, entry.rot + 180) < 1 ? [] : solveJoin(from, entry, this._lead.level);
      if (chain && chainTurn(chain) <= MAX_JOIN_TURN && ok({ drop: k, chain })) found.push({ drop: k, chain });
    }
    const best = gentlest(found.map((f) => f.chain));
    return found.find((f) => f.chain === best) ?? null;
  }

  /**
   * True when a crossing's new track (crossover, refill straights and the join chain) overlaps no
   * other same-level track: the world (minus the pieces the splice removes) and the ghost pieces
   * kept (minus the reworked tail and, for a ghost crossing, the crossed ghost straights in `range`).
   * Track joined to the new pieces, directly or through one piece, is exempt as in the graph's
   * overlap test.
   */
  private crossingFits(o: Obstacle, splice: Splice, join: { drop: number; chain: PieceSpec[] }, range: [number, number] | null): boolean {
    const removed = new Set(o.ghost === null ? splice.remove : []);
    const keep = this.pieces.length - join.drop;
    const others: Piece[] = this.world.layout.pieces.filter((p) => !removed.has(p.id));
    this.pieces.slice(0, keep).forEach((s, i) => {
      if (!range || i < range[0] || i > range[1]) others.push(specToPiece(s, ghostId(i)));
    });
    const tag = '\u0000new:';
    const fresh = [...splice.add, ...join.chain].map((s, i) => specToPiece(s, tag + i));
    return !buildGraph([...others, ...fresh]).overlaps.some(([a, b]) => a.startsWith(tag) || b.startsWith(tag));
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
      if (range[0] < this.fixed) return this.red(); // never rework frozen pieces
    }
    const join = this.joinTo(res.entry, (j) => this.crossingFits(o, res.splice, j, range));
    if (!join) return this.red();

    // Rework the trailing pieces and join the entry.
    const keep = this.pieces.length - join.drop;
    this.leadS = keep < this.pieces.length ? this.anchorS[keep] : this.leadS;
    this._lead = { pose: keep < this.pieces.length ? this.anchors[keep] : this._lead.pose, level };
    for (const s of this.pieces.slice(keep)) this.ghostLen -= pieceGeometry(s).routes[0].path.length;
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
      for (const c of this.crossings) {
        if (c.index > hi) c.index += delta;
        if (c.through > hi) c.through += delta;
      }
      const xi = lo + add.findIndex((s) => s.type === res.type);
      this.crossings.push({ index: xi, through: this.pieces.length, splice: { remove: [], add: [] }, ghost: true, type: res.type });
    } else {
      const c = this.crossings.length;
      this.crossings.push({ index: this.pieces.length, through: this.pieces.length, splice: res.splice, ghost: false, type: res.type });
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
    this.ghostLen += pieceGeometry({ type: res.type, flipped: false }).routes[0].path.length;
    this.progressAt = this.length;
    return join.chain.length + 1;
  }
}
