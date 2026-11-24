import type { Doc } from '../model/doc';
import type { Piece, Train, TrackPos } from '../model/types';
import { pieceRoutes } from '../track/catalog';
import { carPoses, distanceAhead, occupiedPieces, trainLength } from '../sim/motion';
import { carsOverlap } from '../sim/collision';
import type { Command } from './history';

const clone = <T>(p: T): T => structuredClone(p);

/**
 * Replace the pieces whose ids match a snapshot, in place in the array. A switch keeps its CURRENT
 * state: toggling is play, not an edit, so undo/redo never roll it back.
 */
function restore(doc: Doc, snaps: Piece[]): void {
  const byId = new Map(snaps.map((p) => [p.id, p]));
  doc.layout.pieces = doc.layout.pieces.map((p) => {
    const snap = byId.get(p.id);
    if (!snap) return p;
    const next = clone(snap);
    if (next.switch && p.switch) next.switch.state = p.switch.state;
    return next;
  });
  doc.rebuild();
}

export function placePieces(pieces: Piece[]): Command {
  const snaps = pieces.map(clone);
  const ids = new Set(snaps.map((p) => p.id));
  return {
    label: 'Place',
    do(doc) { doc.layout.pieces.push(...snaps.map(clone)); doc.rebuild(); },
    undo(doc) {
      liftTrainsOn(doc, ids);
      doc.layout.pieces = doc.layout.pieces.filter((p) => !ids.has(p.id));
      doc.rebuild();
    },
  };
}

export function transformPieces(
  ids: string[],
  next: Map<string, { x: number; y: number; rot: number; flipped?: boolean }>,
): Command {
  let before: Piece[] | null = null;
  let after: Piece[] = [];
  return {
    label: 'Transform',
    do(doc) {
      if (!before) {
        before = ids.map((id) => doc.piece(id)).filter((p): p is Piece => !!p).map(clone);
        after = before.map((p) => {
          const n = next.get(p.id);
          return n ? { ...clone(p), x: n.x, y: n.y, rot: n.rot, flipped: n.flipped ?? p.flipped } : clone(p);
        });
      }
      liftTrainsOn(doc, ids);
      restore(doc, after);
    },
    undo(doc) {
      if (!before) return;
      liftTrainsOn(doc, ids);
      restore(doc, before);
    },
  };
}

export function deletePieces(ids: string[]): Command {
  const idSet = new Set(ids);
  let removed: { index: number; piece: Piece }[] = [];
  return {
    label: 'Delete',
    do(doc) {
      liftTrainsOn(doc, idSet);
      removed = [];
      doc.layout.pieces.forEach((p, index) => { if (idSet.has(p.id)) removed.push({ index, piece: clone(p) }); });
      doc.layout.pieces = doc.layout.pieces.filter((p) => !idSet.has(p.id));
      doc.rebuild();
    },
    undo(doc) {
      // ascending original indices: each insert lands at its final position
      for (const r of removed) doc.layout.pieces.splice(r.index, 0, clone(r.piece));
      doc.rebuild();
    },
  };
}

/** Change a switch's mode; undo/redo touch only the mode, never its live state. */
export function setSwitchMode(id: string, mode: 'manual' | 'auto'): Command {
  let before: 'manual' | 'auto' | null = null;
  const set = (doc: Doc, m: 'manual' | 'auto'): void => {
    const p = doc.piece(id);
    if (!p?.switch) return;
    p.switch = { ...p.switch, mode: m };
    doc.rebuild();
  };
  return {
    label: 'Switch mode',
    do(doc) {
      before = doc.piece(id)?.switch?.mode ?? null;
      if (before !== null) set(doc, mode);
    },
    undo(doc) { if (before !== null) set(doc, before); },
  };
}

export function batch(label: string, cmds: Command[]): Command {
  return {
    label,
    do(doc) { for (const c of cmds) c.do(doc); doc.rebuild(); },
    undo(doc) { for (const c of [...cmds].reverse()) c.undo(doc); doc.rebuild(); },
  };
}

// ---- Trains ----

/** Overwrite the train with the snapshot's id in place (keeps object identity for other holders). */
function restoreTrain(doc: Doc, snap: Train): void {
  const t = doc.train(snap.id);
  if (t) Object.assign(t, clone(snap));
}

const EPS = 1e-6;

/** Does the head's piece and route exist, with room behind it for the whole train before a dead end? */
export function canPlaceTrain(doc: Doc, head: TrackPos, cars: number): boolean {
  const p = doc.piece(head.pieceId);
  if (!p || !pieceRoutes(p.type, p.flipped)[head.route]) return false;
  const len = trainLength(cars);
  const back: TrackPos = { ...head, dir: head.dir === 1 ? -1 : 1 };
  return distanceAhead(doc, back, len) >= len - EPS;
}

export function placeTrain(train: Train): Command {
  const snap = clone(train);
  return {
    label: 'Place train',
    do(doc) { doc.layout.trains.push(clone(snap)); },
    undo(doc) { doc.layout.trains = doc.layout.trains.filter((t) => t.id !== snap.id); },
  };
}

/** Drop a lifted train onto the track, or relocate a placed one; it lands stopped and un-crashed. */
export function moveTrain(id: string, head: TrackPos): Command {
  let before: Train | null = null;
  return {
    label: 'Move train',
    do(doc) {
      const t = doc.train(id);
      if (!t) { before = null; return; }
      before = clone(t);
      Object.assign(t, {
        head: { ...head }, lifted: null, running: false, currentSpeed: 0, crashed: false, crashAt: null,
      });
    },
    undo(doc) { if (before) restoreTrain(doc, before); },
  };
}

export function deleteTrains(ids: string[]): Command {
  const idSet = new Set(ids);
  let removed: { index: number; train: Train }[] = [];
  return {
    label: 'Delete train',
    do(doc) {
      removed = [];
      doc.layout.trains.forEach((t, index) => { if (idSet.has(t.id)) removed.push({ index, train: clone(t) }); });
      doc.layout.trains = doc.layout.trains.filter((t) => !idSet.has(t.id));
    },
    undo(doc) {
      // ascending original indices: each insert lands at its final position
      for (const r of removed) doc.layout.trains.splice(r.index, 0, clone(r.train));
    },
  };
}

export function setTrainProps(id: string, props: Partial<Pick<Train, 'cars' | 'color'>>): Command {
  let before: Pick<Train, 'cars' | 'color'> | null = null;
  return {
    label: 'Train properties',
    do(doc) {
      const t = doc.train(id);
      if (!t) { before = null; return; }
      before = { cars: t.cars, color: t.color };
      if (props.cars !== undefined) t.cars = props.cars;
      if (props.color !== undefined) t.color = props.color;
    },
    undo(doc) {
      const t = doc.train(id);
      if (t && before) Object.assign(t, before);
    },
  };
}

/** Would `train` with its head at `head` overlap any other placed train? */
function overlapsOthers(doc: Doc, train: Train, head: TrackPos): boolean {
  const mine = carPoses(doc, { ...train, head });
  return doc.layout.trains.some((o) => o.id !== train.id && o.head !== null
    && carPoses(doc, o).some((c) => mine.some((m) => carsOverlap(m, c))));
}

/**
 * Lift (at the locomotive's pose, stopped) every placed train occupying any of `pieceIds`, and
 * return snapshots of them as they were. Call it BEFORE removing or moving those pieces — in every
 * do, undo and redo that does so — so no train is ever left pointing at a missing or moved piece.
 */
export function liftTrainsOn(doc: Doc, pieceIds: Iterable<string>): Train[] {
  const idSet = new Set(pieceIds);
  const lifted: Train[] = [];
  for (const t of doc.layout.trains) {
    if (t.head === null) continue;
    if (![...occupiedPieces(doc, t)].some((id) => idSet.has(id))) continue;
    const loco = carPoses(doc, t)[0];
    lifted.push(clone(t));
    Object.assign(t, {
      head: null, lifted: { x: loco.center.x, y: loco.center.y, rot: loco.heading },
      running: false, currentSpeed: 0,
    });
  }
  return lifted;
}

/**
 * Wrap a piece edit (spec §5.5a): before `inner.do`, every train on any of `pieceIds` is lifted at its
 * locomotive's pose and stopped. Undo restores such trains (still lifted) to their old spot, stopped,
 * when the track is back and no other train is in the way; otherwise they stay lifted.
 */
export function withLifting(doc: Doc, pieceIds: string[], inner: Command): Command {
  void doc; // occupancy is computed at do time (also on redo), against the doc passed to `do`
  const idSet = new Set(pieceIds);
  let lifted: Train[] = [];
  return {
    label: inner.label,
    do(d) {
      lifted = liftTrainsOn(d, idSet);
      inner.do(d);
    },
    undo(d) {
      inner.undo(d);
      for (const prior of lifted) {
        const t = d.train(prior.id);
        const head = prior.head;
        if (!t || t.head !== null || head === null) continue;
        if (!canPlaceTrain(d, head, t.cars) || overlapsOthers(d, t, head)) continue;
        Object.assign(t, {
          head: { ...head }, lifted: null, running: false, currentSpeed: 0, crashed: false, crashAt: null,
        });
      }
    },
  };
}
