import { getPieceDef, pieceConnectors, pieceRoutes } from '../track/catalog';
import type { Doc } from '../model/doc';
import type { Train, TrackPos } from '../model/types';
import { advance, distanceAhead, occupiedPieces, reverseHead, routeEntering } from './motion';
import { checkCollisions } from './collision';

/** Acceleration and braking, in U/s². */
export const ACCEL = 1.5;
/** Fixed substep length, in seconds. */
export const STEP = 1 / 120;
/** Longest frame time simulated in one `step`, in seconds. */
export const MAX_DT = 0.25;
/** Fractional speed change on a ramp with the hill effect on. */
export const HILL_FACTOR = 0.35;

export class Simulation {
  paused = false;
  private doc: Doc;
  /** Auto switches each train has entered facing and that flip once nothing occupies them. */
  private pendingFlips = new Map<string, Set<string>>();

  constructor(doc: Doc) { this.doc = doc; }

  step(dt: number): void {
    if (this.paused) return;
    const t = Math.min(dt, MAX_DT);
    if (!(t > 0)) return;
    this.prune();
    // The epsilon keeps e.g. 0.25 / (1/120) = 30.000000000000004 at 30 substeps.
    const n = Math.max(1, Math.ceil(t / STEP - 1e-9));
    const h = t / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }

  canToggle(pieceId: string): boolean {
    const p = this.doc.piece(pieceId);
    if (!p || !getPieceDef(p.type).switch) return false;
    return !this.occupiedBy(null).has(pieceId);
  }

  toggleSwitch(pieceId: string): boolean {
    if (!this.canToggle(pieceId)) return false;
    const p = this.doc.piece(pieceId)!;
    if (p.switch) p.switch.state = p.switch.state === 0 ? 1 : 0;
    else p.switch = { mode: 'manual', state: 1 };
    return true;
  }

  reverse(trainId: string): void {
    const t = this.doc.train(trainId);
    if (!t || t.head === null) return;
    t.head = reverseHead(this.doc, t);
    t.currentSpeed = 0;
    t.crashed = false;
    t.crashAt = null;
  }

  forget(trainId: string): void { this.pendingFlips.delete(trainId); }

  /** Drop internal state of trains that were deleted or lifted. */
  private prune(): void {
    for (const id of [...this.pendingFlips.keys()]) {
      const t = this.doc.train(id);
      if (!t || t.head === null) this.pendingFlips.delete(id);
    }
  }

  /** Pieces occupied by every placed train except `exceptId`. */
  private occupiedBy(exceptId: string | null): Set<string> {
    const s = new Set<string>();
    for (const t of this.doc.layout.trains) {
      if (t.head === null || t.id === exceptId) continue;
      for (const id of occupiedPieces(this.doc, t)) s.add(id);
    }
    return s;
  }

  private substep(h: number): void {
    for (const t of this.doc.layout.trains) if (t.head !== null) this.moveTrain(t, h);
    this.resolveFlips();
    checkCollisions(this.doc);
  }

  private targetSpeed(t: Train, head: TrackPos): number {
    if (!t.running || t.crashed) return 0;
    let target = t.speed * this.hillMultiplier(head);
    const v = t.currentSpeed;
    const stopDist = (v * v) / (2 * ACCEL);
    if (distanceAhead(this.doc, head, stopDist + 0.01) <= stopDist) target = 0;
    return target;
  }

  private hillMultiplier(head: TrackPos): number {
    if (!this.doc.layout.settings.hillEffect) return 1;
    const p = this.doc.piece(head.pieceId);
    if (!p || !getPieceDef(p.type).ramp) return 1;
    const route = pieceRoutes(p.type, p.flipped)[head.route];
    if (!route || route.to === null) return 1;
    const conns = pieceConnectors(p.type, p.flipped);
    const enter = head.dir === 1 ? route.from : route.to;
    const exit = head.dir === 1 ? route.to : route.from;
    const rise = conns[exit].levelOffset - conns[enter].levelOffset;
    return rise > 0 ? 1 - HILL_FACTOR : rise < 0 ? 1 + HILL_FACTOR : 1;
  }

  private moveTrain(t: Train, h: number): void {
    const head = t.head!;
    const target = this.targetSpeed(t, head);
    const dv = ACCEL * h;
    t.currentSpeed = target > t.currentSpeed
      ? Math.min(target, t.currentSpeed + dv)
      : Math.max(target, t.currentSpeed - dv);
    if (t.currentSpeed <= 0) { t.currentSpeed = 0; return; }

    // Trailing switches are aligned below, skipping any another train occupies (never split a train).
    const r = advance(this.doc, head, t.currentSpeed * h, { alignTrailing: false });
    t.head = r.pos;
    if (r.hitEnd) t.currentSpeed = 0;

    let others: Set<string> | null = null;
    for (const e of r.entered) {
      const p = this.doc.piece(e.pieceId);
      if (!p) continue;
      const sw = getPieceDef(p.type).switch;
      if (!sw) continue;
      if (e.facing) {
        if (p.switch?.mode === 'auto') {
          let set = this.pendingFlips.get(t.id);
          if (!set) this.pendingFlips.set(t.id, (set = new Set()));
          set.add(p.id);
        }
        continue;
      }
      others ??= this.occupiedBy(t.id);
      if (others.has(p.id)) continue;
      const route = routeEntering(this.doc, p.id, e.viaConnector).route;
      const state: 0 | 1 = sw.routes[0] === route ? 0 : 1;
      if (p.switch) p.switch.state = state;
      else p.switch = { mode: 'manual', state };
    }
  }

  /** Flip each pending auto switch that no train occupies any more (once, however many trains wait on it). */
  private resolveFlips(): void {
    if (this.pendingFlips.size === 0) return;
    const occupied = this.occupiedBy(null);
    const toFlip = new Set<string>();
    for (const [id, set] of this.pendingFlips) {
      for (const pieceId of set) {
        const p = this.doc.piece(pieceId);
        if (!p || !p.switch || p.switch.mode !== 'auto') { set.delete(pieceId); continue; }
        if (occupied.has(pieceId)) continue;
        toFlip.add(pieceId);
        set.delete(pieceId);
      }
      if (set.size === 0) this.pendingFlips.delete(id);
    }
    for (const pieceId of toFlip) {
      const sw = this.doc.piece(pieceId)!.switch!;
      sw.state = sw.state === 0 ? 1 : 0;
    }
  }
}
