import type { Doc } from '../model/doc';
import type { Piece } from '../model/types';
import type { Command } from './history';

const clone = (p: Piece): Piece => structuredClone(p);

/** Replace the pieces whose ids match a snapshot, in place in the array. */
function restore(doc: Doc, snaps: Piece[]): void {
  const byId = new Map(snaps.map((p) => [p.id, p]));
  doc.layout.pieces = doc.layout.pieces.map((p) => (byId.has(p.id) ? clone(byId.get(p.id)!) : p));
  doc.rebuild();
}

export function placePieces(pieces: Piece[]): Command {
  const snaps = pieces.map(clone);
  const ids = new Set(snaps.map((p) => p.id));
  return {
    label: 'Place',
    do(doc) { doc.layout.pieces.push(...snaps.map(clone)); doc.rebuild(); },
    undo(doc) { doc.layout.pieces = doc.layout.pieces.filter((p) => !ids.has(p.id)); doc.rebuild(); },
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
      restore(doc, after);
    },
    undo(doc) { if (before) restore(doc, before); },
  };
}

export function deletePieces(ids: string[]): Command {
  const idSet = new Set(ids);
  let removed: { index: number; piece: Piece }[] = [];
  return {
    label: 'Delete',
    do(doc) {
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

export function setSwitchMode(id: string, mode: 'manual' | 'auto'): Command {
  let before: Piece | null = null;
  return {
    label: 'Switch mode',
    do(doc) {
      const p = doc.piece(id);
      if (!p?.switch) return;
      before = clone(p);
      p.switch = { ...p.switch, mode };
      doc.rebuild();
    },
    undo(doc) { if (before) restore(doc, [before]); },
  };
}

export function batch(label: string, cmds: Command[]): Command {
  return {
    label,
    do(doc) { for (const c of cmds) c.do(doc); doc.rebuild(); },
    undo(doc) { for (const c of [...cmds].reverse()) c.undo(doc); doc.rebuild(); },
  };
}
