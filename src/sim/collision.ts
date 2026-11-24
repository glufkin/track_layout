import { type Vec2, fromAngle } from '../geom/vec';
import type { Doc } from '../model/doc';
import { carPoses, CAR_WIDTH, type CarPose } from './motion';

export interface Collision { a: string; b: string; at: Vec2 }

const corners = (c: CarPose): Vec2[] => {
  const f = fromAngle(c.heading);
  const hl = c.length / 2, hw = CAR_WIDTH / 2;
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) => ({
    x: c.center.x + f.x * hl * s - f.y * hw * t,
    y: c.center.y + f.y * hl * s + f.x * hw * t,
  }));
};

/** Do two car rectangles overlap (separating-axis test)? Cars on different levels never do. */
export function carsOverlap(a: CarPose, b: CarPose): boolean {
  if (a.level !== b.level) return false;
  const ca = corners(a), cb = corners(b);
  for (const h of [a.heading, b.heading]) {
    for (const deg of [h, h + 90]) {
      const ax = fromAngle(deg);
      const proj = (cs: Vec2[]): [number, number] => {
        const v = cs.map((p) => p.x * ax.x + p.y * ax.y);
        return [Math.min(...v), Math.max(...v)];
      };
      const [a0, a1] = proj(ca), [b0, b1] = proj(cb);
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

const radius = (c: CarPose): number => Math.hypot(c.length / 2, CAR_WIDTH / 2);

interface Hit extends Collision { /** Loco heading of `a` and `b` and the centre of the other train's overlapping car. */
  aHeadsToward: boolean; bHeadsToward: boolean }

function findHits(doc: Doc): Hit[] {
  const placed = doc.layout.trains.filter((t) => t.head !== null).map((t) => ({ id: t.id, cars: carPoses(doc, t) }));
  const hits: Hit[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j];
      const hit = firstOverlap(A.cars, B.cars);
      if (!hit) continue;
      const [ca, cb] = hit;
      hits.push({
        a: A.id, b: B.id,
        at: { x: (ca.center.x + cb.center.x) / 2, y: (ca.center.y + cb.center.y) / 2 },
        aHeadsToward: headsToward(A.cars[0], cb), bHeadsToward: headsToward(B.cars[0], ca),
      });
    }
  }
  return hits;
}

function firstOverlap(as: CarPose[], bs: CarPose[]): [CarPose, CarPose] | null {
  for (const a of as) {
    for (const b of bs) {
      const dx = a.center.x - b.center.x, dy = a.center.y - b.center.y;
      const r = radius(a) + radius(b);
      if (dx * dx + dy * dy > r * r) continue;
      if (carsOverlap(a, b)) return [a, b];
    }
  }
  return null;
}

/** Is the other car ahead of this train's locomotive (in its direction of travel)? */
function headsToward(loco: CarPose, other: CarPose): boolean {
  const f = fromAngle(loco.heading);
  return f.x * (other.center.x - loco.center.x) + f.y * (other.center.y - loco.center.y) > 0;
}

/** Overlapping train pairs among placed (non-lifted) trains, with the contact point. */
export function findCollisions(doc: Doc): Collision[] {
  return findHits(doc).map(({ a, b, at }) => ({ a, b, at }));
}

/**
 * Stop and flag colliding trains (when collisions are on), and release any crashed train that no longer
 * overlaps another train (crash clears when either train is reversed, moved or deleted).
 */
export function checkCollisions(doc: Doc): void {
  const hits = findHits(doc);
  const touching = new Set<string>();
  const on = doc.layout.settings.collisions;
  for (const h of hits) {
    touching.add(h.a); touching.add(h.b);
    if (!on) continue;
    const ta = doc.train(h.a)!, tb = doc.train(h.b)!;
    // A train released from a crash (e.g. reversed) still touches its old partner: it only crashes
    // again if it is heading into it.
    if (ta.crashed && !tb.crashed && !h.bHeadsToward) continue;
    if (tb.crashed && !ta.crashed && !h.aHeadsToward) continue;
    for (const t of [ta, tb]) {
      if (t.crashed) continue;
      t.running = false;
      t.currentSpeed = 0;
      t.crashed = true;
      t.crashAt = h.at;
    }
  }
  for (const t of doc.layout.trains) {
    if (t.crashed && !touching.has(t.id)) { t.crashed = false; t.crashAt = null; }
  }
}
