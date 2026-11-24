import { type Layout, type Piece, type Train } from './types';
import { type TrackGraph, buildGraph } from '../track/graph';

export class Doc {
  layout: Layout;
  graph: TrackGraph;

  constructor(layout: Layout) {
    this.layout = layout;
    this.graph = buildGraph(layout.pieces);
  }

  rebuild(): void { this.graph = buildGraph(this.layout.pieces); }

  piece(id: string): Piece | undefined { return this.layout.pieces.find((p) => p.id === id); }
  train(id: string): Train | undefined { return this.layout.trains.find((t) => t.id === id); }

  /** An id with the given prefix that no piece or train currently uses. */
  newId(prefix: 'p' | 't'): string {
    const used = new Set<string>([...this.layout.pieces.map((p) => p.id), ...this.layout.trains.map((t) => t.id)]);
    let n = 1;
    for (const id of used) {
      const m = /^[pt](\d+)$/.exec(id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    while (used.has(prefix + n)) n++;
    return prefix + n;
  }
}
