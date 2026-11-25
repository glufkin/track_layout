import type { Pose, Vec2 } from '../geom/vec';
import type { FlexParams } from '../track/catalog';

export type StyleId = 'wooden' | 'model' | 'brick';

export interface SwitchSettings { mode: 'manual' | 'auto'; state: 0 | 1 }

export interface Piece {
  id: string; type: string;
  x: number; y: number; rot: number;
  level: number; flipped: boolean;
  switch?: SwitchSettings;
  /** Required on the flex types (`flex-straight`, `flex-curve`), absent on all others. */
  flex?: FlexParams;
}

/** `dist` is measured from the route's `from` connector; `dir: 1` travels from -> to. */
export interface TrackPos { pieceId: string; route: number; dist: number; dir: 1 | -1 }

/** A train is lifted exactly when `head === null`. */
export interface Train {
  id: string; cars: number; color: string; speed: number; running: boolean;
  head: TrackPos | null; lifted: Pose | null;
  currentSpeed: number; crashed: boolean; crashAt: Vec2 | null;
}

export interface Settings { collisions: boolean; hillEffect: boolean; gridVisible: boolean }

export interface Layout { style: StyleId; settings: Settings; pieces: Piece[]; trains: Train[] }

export const MAX_LEVEL = 3;
export const MAX_CARS = 20;

export const emptyLayout = (): Layout => ({
  style: 'wooden',
  settings: { collisions: true, hillEffect: false, gridVisible: true },
  pieces: [],
  trains: [],
});
