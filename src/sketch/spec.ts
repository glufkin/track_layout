import { type Pose, applyPose, rotate, normDeg } from '../geom/vec';
import { type FlexParams, pieceGeometry } from '../track/catalog';
import type { Piece } from '../model/types';

/** A piece not yet given an id: what sketch and join code builds before committing. */
export type PieceSpec = Omit<Piece, 'id'>;

const copyFlex = (f: FlexParams): FlexParams => ({ ...f });

export function specToPiece(spec: PieceSpec, id: string): Piece {
  const p: Piece = { ...spec, id };
  if (spec.flex) p.flex = copyFlex(spec.flex);
  if (spec.switch) p.switch = { ...spec.switch };
  return p;
}

/** World pose of one of the spec's connectors, with `rot` = its outward heading. */
export function outPose(spec: PieceSpec, connector: number): Pose {
  const c = pieceGeometry(spec).connectors[connector];
  const pos = applyPose(spec, c.pos);
  return { x: pos.x, y: pos.y, rot: normDeg(c.heading + spec.rot) };
}

/**
 * Place a piece so that its connector `enter` mates with the outward pose `at`: same position,
 * opposite heading. The piece's rot is `at.rot + 180 - conn.heading` (normalised).
 */
export function attachSpec(
  type: string, flipped: boolean, flex: FlexParams | undefined, at: Pose, level: number, enter = 0,
): PieceSpec {
  const geo = pieceGeometry({ type, flipped, flex });
  const c = geo.connectors[enter];
  const rot = normDeg(at.rot + 180 - c.heading);
  const off = rotate(c.pos, rot);
  const spec: PieceSpec = { type, x: at.x - off.x, y: at.y - off.y, rot, level, flipped };
  if (flex) spec.flex = copyFlex(flex);
  return spec;
}

/** Outward pose of the last spec's `exit` connector. */
export function chainEnd(specs: PieceSpec[], exit = 1): Pose {
  if (specs.length === 0) throw new Error('chainEnd of an empty chain');
  return outPose(specs[specs.length - 1], exit);
}
