import type { Vec2 } from '../geom/vec';
import type { Piece, StyleId, Train } from '../model/types';
import type { CarPose } from '../sim/motion';
import { WOODEN } from './styles/wooden';
import { MODEL } from './styles/model';
import { BRICK_STYLE } from './styles/brick';

export { strokeRoute, connectorShape, traceRoute, tracePartialRoute, tracePolys, tint, pegCentre, PEG_R, PEG_REACH } from './draw';

export interface PieceDrawOpts { ghost?: boolean; selected?: boolean }

/**
 * A visual style. Every method draws in **world units** (U): the renderer has already applied
 * the camera transform. Methods may change any context state but must leave the transform as
 * they found it (use save/restore).
 */
export interface Style {
  id: StyleId;
  name: string;
  /** Paint the table over at least the world rectangle viewMin..viewMax. */
  background(ctx: CanvasRenderingContext2D, viewMin: Vec2, viewMax: Vec2, gridVisible: boolean): void;
  piece(ctx: CanvasRenderingContext2D, piece: Piece, opts: PieceDrawOpts): void;
  tunnelCover(ctx: CanvasRenderingContext2D, piece: Piece): void;
  car(ctx: CanvasRenderingContext2D, car: CarPose, train: Train): void;
}

/** All styles by id. */
export const STYLES: Record<StyleId, Style> = {
  wooden: WOODEN,
  model: MODEL,
  brick: BRICK_STYLE,
};
