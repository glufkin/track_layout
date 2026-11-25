import { test, expect } from 'vitest';
import { PALETTE_ORDER, getPieceDef } from '../../src/track/catalog';
import { Doc } from '../../src/model/doc';
import { emptyLayout, MAX_LEVEL, type Piece, type Train, type TrackPos } from '../../src/model/types';
import { render, liftedCarPoses, INVALID_TRAIN_COLOR, type Overlay } from '../../src/render/renderer';
import { STYLES } from '../../src/render/style';
import { defaultCamera } from '../../src/render/camera';
import { LOCO_LEN, CAR_LEN, COUPLING } from '../../src/sim/motion';
import { mockContext } from '../helpers/mockCtx';

const size = { x: 800, y: 600 };
const P = (id: string, type: string, x: number, y: number, o: Partial<Piece> = {}): Piece =>
  ({ id, type, x, y, rot: 0, level: 0, flipped: false, ...o });
const T = (pieceId: string, dist: number, dir: 1 | -1 = 1, route = 0): TrackPos => ({ pieceId, route, dist, dir });
const train = (id: string, head: TrackPos | null, o: Partial<Train> = {}): Train => ({
  id, cars: 2, color: '#123456', speed: 1, running: false, head, lifted: null,
  currentSpeed: 0, crashed: false, crashAt: null, ...o,
});
const overlay = (o: Partial<Overlay> = {}): Overlay => ({ selectedPieces: new Set(), showConnectors: false, ...o });
const BAND = '#d9b27c';

const STYLE_IDS = ['wooden', 'model', 'brick'] as const;
const TABLE_COLOURS = { wooden: '#e8d3a9', model: '#7da35a', brick: '#3a9a3a' } as const;

test('all three styles are registered with their own id and name', () => {
  expect(STYLE_IDS.map((id) => STYLES[id].id)).toEqual(['wooden', 'model', 'brick']);
  expect(STYLE_IDS.map((id) => STYLES[id].name)).toEqual(['Wooden', 'Model train', 'Toy brick']);
});

test.each(STYLE_IDS)('render does not throw for every catalogue type, both flips, levels 0..3, with every overlay (%s)', (sid) => {
  const pieces: Piece[] = [];
  let n = 0;
  PALETTE_ORDER.forEach((type, i) => {
    for (const flipped of [false, true]) for (let level = 0; level <= MAX_LEVEL; level++) {
      const p = P('p' + n++, type, i * 3, level * 3 + (flipped ? 15 : 0), { flipped, level, rot: 22.5 * level });
      if (getPieceDef(type).switch) p.switch = { mode: 'manual', state: (level % 2) as 0 | 1 };
      pieces.push(p);
    }
  });
  const ramp = P('ramp', 'ramp-2', -10, -10);
  const top = P('top', 'straight-2', -8, -10, { level: 1 });
  pieces.push(ramp, top);
  const trains = [
    train('onRamp', T('ramp', 1.2), { cars: 3 }),
    train('crashed', T('top', 1.5), { crashed: true, crashAt: { x: -7, y: -10 } }),
    train('lifted', null, { lifted: { x: 5, y: 5, rot: 30 }, crashed: true, crashAt: { x: 5, y: 5 } }),
  ];
  const d = new Doc({ ...emptyLayout(), pieces, trains });
  const { ctx, calls } = mockContext();
  const ov = overlay({
    selectedPieces: new Set(['p0', 'p5', 'ramp']), selectedTrain: 'onRamp', showConnectors: true,
    ghost: { piece: P('g', 'switch', 0, -5, { switch: { mode: 'manual', state: 1 } }), valid: false },
    ghostTrain: liftedCarPoses({ x: 1, y: -6, rot: 0 }, 2),
  });
  expect(() => render(ctx, d, defaultCamera(), size, ov, sid)).not.toThrow();
  expect(() => render(ctx, d, defaultCamera(), size, overlay({ ghost: { piece: ramp, valid: true } }), 'wooden')).not.toThrow();
  expect(calls.length).toBeGreaterThan(100);
});

test.each(STYLE_IDS)('background is painted first, in the table colour (%s)', (sid) => {
  const { ctx, calls } = mockContext();
  render(ctx, new Doc(emptyLayout()), defaultCamera(), size, overlay(), sid);
  const first = calls.find((c) => c.name === 'fill' || c.name === 'fillRect');
  expect(first).toBeDefined();
  expect(first!.fillStyle).toBe(TABLE_COLOURS[sid]);
});

test('a level-1 piece is drawn after a level-0 car', () => {
  const low = P('low', 'straight-2', 0, 0);
  const high = P('high', 'straight-2', 0, 3, { level: 1 });
  const d = new Doc({ ...emptyLayout(), pieces: [high, low], trains: [train('t', T('low', 1.8), { cars: 0 })] });
  const { ctx, calls } = mockContext();
  render(ctx, d, defaultCamera(), size, overlay(), 'wooden');
  const carFill = calls.findIndex((c) => c.name === 'fill' && c.fillStyle === '#123456');
  expect(carFill).toBeGreaterThan(-1);
  const shadow = calls.findIndex((c) => c.name === 'fill' && c.fillStyle === 'rgba(0,0,0,0.25)');
  expect(shadow).toBeGreaterThan(carFill);
  // The level-1 band (stroked along its route) also comes after the car.
  const highBand = calls.findIndex((c, i) => i > carFill && c.name === 'stroke' && c.strokeStyle === BAND);
  expect(highBand).toBeGreaterThan(carFill);
});

test('a lifted train is drawn at 40% alpha, without a crash marker', () => {
  const lifted = train('l', null, { lifted: { x: 0, y: 0, rot: 0 }, crashed: true, crashAt: { x: 0, y: 0 } });
  const d = new Doc({ ...emptyLayout(), trains: [lifted] });
  const { ctx, calls } = mockContext();
  render(ctx, d, defaultCamera(), size, overlay(), 'wooden');
  const loco = calls.filter((c) => c.name === 'fill' && c.fillStyle === '#123456');
  expect(loco.length).toBeGreaterThan(0);
  for (const c of loco) expect(c.globalAlpha).toBe(0.4);
  expect(calls.some((c) => c.name === 'fill' && c.fillStyle === '#e53935')).toBe(false);
});

test('a placed crashed train gets a red crash star', () => {
  const s = P('s', 'straight-2', 0, 0);
  const d = new Doc({ ...emptyLayout(), pieces: [s], trains: [train('t', T('s', 1.5), { cars: 0, crashed: true, crashAt: { x: 1.5, y: 0 } })] });
  const { ctx, calls } = mockContext();
  render(ctx, d, defaultCamera(), size, overlay(), 'wooden');
  expect(calls.some((c) => c.name === 'fill' && c.fillStyle === '#e53935')).toBe(true);
});

test('tunnel covers are drawn over the level-0 cars inside them', () => {
  const tun = P('tun', 'tunnel-2', 0, 0);
  const d = new Doc({ ...emptyLayout(), pieces: [tun], trains: [train('t', T('tun', 1.5), { cars: 0 })] });
  const { ctx, calls } = mockContext();
  render(ctx, d, defaultCamera(), size, overlay(), 'wooden');
  const carFill = calls.findIndex((c) => c.name === 'fill' && c.fillStyle === '#123456');
  const tunnelSpy = mockContext();
  STYLES.wooden.tunnelCover(tunnelSpy.ctx, tun);
  const coverFirst = tunnelSpy.calls.find((c) => c.name === 'fill' || c.name === 'stroke')!;
  const coverIdx = calls.findIndex((c, i) => i > carFill && c.name === coverFirst.name
    && c.fillStyle === coverFirst.fillStyle && c.strokeStyle === coverFirst.strokeStyle);
  expect(carFill).toBeGreaterThan(-1);
  expect(coverIdx).toBeGreaterThan(carFill);
});

test('liftedCarPoses lays the cars straight behind the loco along its heading', () => {
  const poses = liftedCarPoses({ x: 2, y: 1, rot: 90 }, 2);
  expect(poses).toHaveLength(3);
  expect(poses[0].isLoco).toBe(true);
  expect(poses[0].center.x).toBeCloseTo(2);
  expect(poses[0].center.y).toBeCloseTo(1);
  const gap = LOCO_LEN / 2 + COUPLING + CAR_LEN / 2;
  expect(poses[1].center.x).toBeCloseTo(2);
  expect(poses[1].center.y).toBeCloseTo(1 - gap);
  expect(poses[2].center.y).toBeCloseTo(1 - gap - CAR_LEN - COUPLING);
  for (const p of poses) expect(p.heading).toBe(90);
});

test('open connectors are drawn only when showConnectors is on', () => {
  const s = P('s', 'straight-1', 0, 0);
  const d = new Doc({ ...emptyLayout(), pieces: [s] });
  const a = mockContext(), b = mockContext();
  render(a.ctx, d, defaultCamera(), size, overlay(), 'wooden');
  render(b.ctx, d, defaultCamera(), size, overlay({ showConnectors: true }), 'wooden');
  expect(b.calls.length).toBeGreaterThan(a.calls.length);
});

test.each(['model', 'brick'] as const)('%s style draws bridges, tunnels and cars without wooden pegs', (sid) => {
  const d = new Doc({ ...emptyLayout(), pieces: [P('b', 'bridge-2', 0, 0), P('t', 'tunnel-2', 4, 0)], trains: [train('x', T('b', 1), { cars: 1 })] });
  const { ctx, calls } = mockContext();
  render(ctx, d, defaultCamera(), size, overlay(), sid);
  expect(calls.some((c) => c.fillStyle === '#c49a62' || c.strokeStyle === '#c49a62')).toBe(false);
  expect(calls.some((c) => c.name === 'fill' && c.fillStyle === '#123456')).toBe(true);
});

test('brick studs are only drawn at high zoom', () => {
  const draw = (scale: number) => {
    const { ctx, calls } = mockContext();
    (ctx as unknown as { getTransform: () => { a: number } }).getTransform = () => ({ a: scale });
    STYLES.brick.background(ctx, { x: 0, y: 0 }, { x: 10, y: 10 }, false);
    return calls.filter((c) => c.name === 'arc').length;
  };
  expect(draw(10)).toBe(0);
  expect(draw(40)).toBeGreaterThan(0);
});

test('an invalid train ghost is drawn in the invalid red', () => {
  const ghostTrain = liftedCarPoses({ x: 1, y: -6, rot: 0 }, 0);
  const fills = (valid: boolean): unknown[] => {
    const { ctx, calls } = mockContext();
    render(ctx, new Doc(emptyLayout()), defaultCamera(), size, overlay({ ghostTrain, ghostTrainValid: valid }), 'wooden');
    return calls.filter((c) => c.name === 'fill' || c.name === 'fillRect').map((c) => c.fillStyle);
  };
  expect(fills(false)).toContain(INVALID_TRAIN_COLOR);
  expect(fills(true)).not.toContain(INVALID_TRAIN_COLOR);
});

test.each(STYLE_IDS)('flex pieces render in both flips (%s)', (sid) => {
  const { ctx } = mockContext();
  const pieces = [
    P('a', 'flex-straight', 0, 0, { flex: { length: 2 } }), P('b', 'flex-straight', 0, 3, { flex: { length: 0.3 }, flipped: true }),
    P('c', 'flex-curve', 5, 0, { flex: { radius: 3, sweep: 30 } }), P('d', 'flex-curve', 5, 5, { flex: { radius: 2, sweep: 45 }, flipped: true }),
  ];
  expect(() => render(ctx, new Doc({ ...emptyLayout(), pieces }), defaultCamera(), size, overlay(), sid)).not.toThrow();
});

test('wooden flex pieces get a joint line across the band at each end', () => {
  const strokes = (type: string, extra: Partial<Piece>): number => {
    const { ctx, calls } = mockContext();
    STYLES.wooden.piece(ctx, P('x', type, 0, 0, extra), {});
    return calls.filter((c) => c.name === 'stroke').length;
  };
  expect(strokes('flex-straight', { flex: { length: 1 } })).toBeGreaterThanOrEqual(strokes('straight-1', {}) + 2);
  expect(strokes('flex-curve', { flex: { radius: 2.5, sweep: 22.5 } })).toBeGreaterThanOrEqual(strokes('curve-m-45', {}) + 2);
});

test('a flashing near-miss ring is stroked red at its centre', () => {
  const rings = (o: Partial<Overlay>) => {
    const { ctx, calls } = mockContext();
    render(ctx, new Doc(emptyLayout()), defaultCamera(), size, overlay(o), 'wooden');
    return calls.filter((c, i) => c.name === 'stroke' && c.strokeStyle === '#e53935' && calls[i - 1]?.name === 'arc')
      .map((c) => calls[calls.indexOf(c) - 1].args.slice(0, 2));
  };
  expect(rings({ flashRing: { x: 2, y: 3 } })).toEqual([[2, 3]]);
  expect(rings({})).toEqual([]);
});

test('sketch overlay: stroke (red from redFrom), 50% ghost, ramp badge, switch outline, refused ✕', () => {
  const { ctx, calls } = mockContext();
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  const ov = overlay({
    sketch: {
      points, ghost: [P('g0', 'straight-1', 0, 0), P('g1', 'ramp-2', 1, 0)], level: 0, redFrom: 2, pendingRamp: 1,
      lead: { x: 1, y: 0 }, refusedAt: { x: 5, y: 5 },
      switchPreview: [P('sw', 'switch', 0, 2, { switch: { mode: 'manual', state: 0 } })],
    },
  });
  render(ctx, new Doc(emptyLayout()), defaultCamera(), size, ov, 'wooden');
  const strokes = calls.filter((c) => c.name === 'stroke');
  expect(strokes.some((c) => c.strokeStyle === 'rgba(30,136,229,0.55)')).toBe(true);
  expect(strokes.some((c) => c.strokeStyle === 'rgba(229,57,53,0.8)')).toBe(true);
  expect(calls.some((c) => c.globalAlpha === 0.5 && (c.name === 'fill' || c.name === 'stroke'))).toBe(true);
  expect(calls.find((c) => c.name === 'fillText')?.args[0]).toBe('↑');
  expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
  expect(strokes.some((c) => c.strokeStyle === '#e53935')).toBe(true);
});
