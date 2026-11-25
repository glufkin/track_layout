import { type Pose, normDeg } from '../geom/vec';
import type { Doc } from '../model/doc';
import { pieceGeometry } from '../track/catalog';
import { type WorldConnector, buildGraph, connKey, worldConnectors } from '../track/graph';
import { batch, deletePieces, placePieces, withLifting } from '../editor/commands';
import type { Command } from '../editor/history';
import { solveJoin } from './join';
import { type PieceSpec, specToPiece } from './spec';

/** Most neighbouring pieces a near-miss close may consume on each side (spec §5.1). */
export const MAX_CONSUME = 2;

/**
 * Plain track a near-miss close may consume: catalogue straights and curves and both flex types.
 * Never switches, crossings, ramps, bridges, tunnels or buffers.
 */
export function isPlainTrack(type: string): boolean {
  return type.startsWith('straight-') || type.startsWith('curve-') || type === 'flex-straight' || type === 'flex-curve';
}

const poseOf = (c: WorldConnector): Pose => ({ x: c.pos.x, y: c.pos.y, rot: c.heading });

/**
 * One end of the gap after consuming some pieces: the pieces consumed, the outward pose the new chain
 * must mate with, and the piece that pose belongs to (null when it is a consumed piece's open far end).
 */
interface Side { consumed: string[]; pose: Pose; anchor: string | null }

/**
 * Walk back from open connector `c` consuming up to MAX_CONSUME plain two-connector pieces. Entry n
 * is the side after consuming n pieces; the walk stops at a protected piece, an open far end (after
 * consuming that piece) or a piece in `avoid`.
 */
function walkBack(doc: Doc, c: WorldConnector, avoid: Set<string>): Side[] {
  const sides: Side[] = [{ consumed: [], pose: poseOf(c), anchor: c.pieceId }];
  let at = c;
  while (sides.length <= MAX_CONSUME) {
    const p = doc.piece(at.pieceId);
    if (!p || avoid.has(p.id) || !isPlainTrack(p.type) || pieceGeometry(p).connectors.length !== 2) break;
    const consumed = [...sides[sides.length - 1].consumed, p.id];
    const other = worldConnectors(p)[1 - at.index];
    const mate = doc.graph.joins.get(connKey(p.id, other.index));
    if (!mate) {
      // Nothing beyond: the new chain ends where this piece's far end was, pointing the same way.
      sides.push({ consumed, pose: { ...poseOf(other), rot: normDeg(other.heading + 180) }, anchor: null });
      break;
    }
    sides.push({ consumed, pose: poseOf(mate), anchor: mate.pieceId });
    at = mate;
  }
  return sides;
}

/** Consumption counts (from a, from b), smallest first: a alone, then b alone, then both. */
const COMBOS: Array<[number, number]> = [[1, 0], [0, 1], [2, 0], [0, 2], [1, 1], [2, 1], [1, 2], [2, 2]];

/**
 * Close the near miss between open connectors `a` and `b` with flex (and catalogue) pieces, as one
 * command; null when nothing fits (a chain overlapping other track does not fit). Tries the bare gap first, then consumes up to two plain pieces
 * backwards from `a`, from `b`, then from both, re-solving between the new outer poses.
 */
export function closeGap(doc: Doc, a: WorldConnector, b: WorldConnector): Command | null {
  const level = a.level;
  const direct = solveJoin(poseOf(a), poseOf(b), level);
  if (direct && fits(doc, [], direct)) return build(doc, [], direct);
  const sa = walkBack(doc, a, new Set([b.pieceId]));
  const sb = walkBack(doc, b, new Set([a.pieceId]));
  for (const [na, nb] of COMBOS) {
    const A = sa[na], B = sb[nb];
    if (!A || !B) continue;
    // On a short loop the two walks can meet: neither may consume a piece the other keeps or mates with.
    if (A.consumed.some((id) => B.consumed.includes(id) || id === B.anchor)) continue;
    if (B.consumed.some((id) => id === A.anchor)) continue;
    const consumed = [...A.consumed, ...B.consumed];
    const chain = solveJoin(A.pose, B.pose, level);
    if (chain && fits(doc, consumed, chain)) return build(doc, consumed, chain);
  }
  return null;
}

/**
 * True when `chain` overlaps no track left after removing `consumed` (pieces joined to it, directly
 * or through one piece, are exempt as in the graph's overlap test).
 */
function fits(doc: Doc, consumed: string[], chain: PieceSpec[]): boolean {
  const gone = new Set(consumed);
  const tag = '\u0000gap:';
  const pieces = [...doc.layout.pieces.filter((p) => !gone.has(p.id)), ...chain.map((s, i) => specToPiece(s, tag + i))];
  return !buildGraph(pieces).overlaps.some(([x, y]) => x.startsWith(tag) || y.startsWith(tag));
}

function build(doc: Doc, consumed: string[], chain: PieceSpec[]): Command {
  const used = new Set(doc.layout.pieces.map((p) => p.id));
  let n = Number(doc.newId('p').slice(1));
  const pieces = chain.map((spec) => {
    // newId only sees the doc, so the later ids of this chain are counted on from the first.
    while (used.has('p' + n)) n++;
    used.add('p' + n);
    return specToPiece(spec, 'p' + n);
  });
  const cmds = consumed.length ? [deletePieces(consumed), placePieces(pieces)] : [placePieces(pieces)];
  return withLifting(doc, consumed, batch('Close gap', cmds));
}
