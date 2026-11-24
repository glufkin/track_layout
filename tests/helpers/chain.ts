import { type Pose, applyPose } from '../../src/geom/vec';
import { pieceConnectors } from '../../src/track/catalog';

export interface ChainStep { type: string; flipped?: boolean; enter?: number; exit?: number }

/**
 * Chain pieces connector-to-connector (geometry only; level offsets are ignored).
 * `start` is the world pose of the FIRST piece's `enter` connector (default 0), `rot` being
 * its outward heading. Every later piece is placed so its `enter` connector sits on the
 * previous piece's `exit` connector (default 1) with the opposite outward heading. Returns
 * the world pose of the last piece's `exit` connector, `rot` its outward heading — so a
 * closed loop ends at `start` with heading `start.rot + 180`.
 */
export function chain(start: Pose, steps: ChainStep[]): Pose {
  // `cur` is the pose of the connector the next piece mates with (the opposite heading).
  let cur: Pose = { ...start, rot: start.rot + 180 };
  for (const step of steps) {
    const conns = pieceConnectors(step.type, step.flipped ?? false);
    const enter = conns[step.enter ?? 0], exit = conns[step.exit ?? 1];
    const rot = cur.rot + 180 - enter.heading;
    const off = applyPose({ x: 0, y: 0, rot }, enter.pos);
    const piece: Pose = { x: cur.x - off.x, y: cur.y - off.y, rot };
    const p = applyPose(piece, exit.pos);
    cur = { x: p.x, y: p.y, rot: rot + exit.heading };
  }
  return cur;
}
