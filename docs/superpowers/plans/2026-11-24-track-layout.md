# Track Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based, top-down toy train track editor and simulator. You lay out snapping track pieces in three visual styles, with switches, levels, trains, collisions, undo and redo, and JSON save files.

**Architecture:** Four layers, of which only the last touches the DOM or canvas:
1. **Model:** plain data, saved and loaded as JSON.
2. **Track:** the piece catalogue, connector maths, auto-join and routes.
3. **Simulation:** a fixed-timestep train simulation.
4. **Editor, renderer and UI:** commands with undo and redo, snapping, drawing on a canvas 2D context, and vanilla DOM panels.

A `Doc` object holds the `Layout` plus the derived `TrackGraph`. Every edit goes through a `Command`.

**Tech Stack:**
- TypeScript (strict), with Vite for development and building.
- Vitest for unit tests.
- The pre-installed `playwright` library for one end-to-end smoke script.
- No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-track-layout-design.md`

## Global Constraints

- Runs in current desktop Chrome, Firefox, Safari and Edge. No server; the build output is a static site (`vite build`).
- TypeScript `strict: true`. **No runtime dependencies**: `dependencies` in package.json stays empty. Dev dependencies are limited to `vite`, `typescript` and `vitest`.
- Drawing uses the canvas 2D API only, and is HiDPI-aware (the backing store is scaled by `devicePixelRatio`).
- Units:
  - World positions are in **U**, where 1U is the length of a standard straight.
  - Angles are in **degrees**, measured from +x toward +y, with y pointing down as on screen. Positive angles therefore turn clockwise on screen.
  - Positive arc sweep means turning right (clockwise).
- Save files: JSON, `"format": "track-layout"`, `"version": 1`, pretty-printed with 2-space indent. Connections are never stored.
- Undo history is at least **200** steps and is never saved.
- Shortcuts: undo is Ctrl-Z (Cmd-Z on macOS). Redo is Ctrl-Shift-Z or Ctrl-Y (Cmd-Shift-Z on macOS).
- Defaults: collisions **on**, hill effect **off**, grid visible **on**, style **wooden**, new switches **manual**.
- The LEGO-style is labelled **"Toy brick"** in the UI, with style id `brick`. No trademarked names or logos appear anywhere. *(Plan call: the spec requires it to evoke the style without copying it.)*

## Review Focus

1. **A huge frame gap**, such as a backgrounded tab resuming after minutes. Trains must not jump through other trains or past dead ends. `step` clamps dt and substeps. Test in Task 8.
2. **A train longer than its loop**, so the locomotive meets its own last car. It must keep running and never collide with itself. Test in Task 9.
3. **Three or more open connectors at the same spot.** Auto-join must pick exactly one pair, deterministically, and leave the rest open. Test in Task 3.
4. **A hand-edited file** with a duplicate id, an unknown piece type, a non-numeric coordinate, or a train pointing at a missing piece. Loading must show a clear error and leave the current layout unchanged. Test in Task 4.
5. **Ctrl-Z typed while a text or number field has focus**, for example a train's colour or car count. It must not undo layout edits. Test in Task 13.

---

## File structure

```
package.json  tsconfig.json  vite.config.ts  index.html
src/
  main.ts                    entry: builds App, mounts to #app
  geom/vec.ts                Vec2/Pose maths
  geom/path.ts               line/arc segments, path sampling
  track/catalog.ts           piece definitions + geometry constants
  track/graph.ts             world connectors, auto-join, near-misses, overlaps
  model/types.ts             Layout, Piece, Train, Settings
  model/doc.ts               Doc = layout + derived graph, id generation
  io/serialize.ts            JSON save/load/validate, autosave
  editor/history.ts          Command, History
  editor/commands.ts         all edit commands (pieces, switches, trains)
  editor/snapping.ts         ghost placement + group snap
  sim/motion.ts              TrackPos advance/walk-back, car poses, occupancy
  sim/simulation.ts          step(): speeds, switches, hill, dead ends
  sim/collision.ts           car rectangles, train-vs-train detection
  render/camera.ts           camera, world<->screen
  render/style.ts            Style interface, shared drawing helpers
  render/styles/wooden.ts    model.ts  brick.ts
  render/renderer.ts         layered scene drawing + overlays
  ui/app.ts                  App: owns Doc, History, sim loop, render loop
  ui/input.ts                mouse/keyboard state machine
  ui/toolbar.ts  ui/palette.ts  ui/panels.ts
tests/   (mirrors src/, *.test.ts)
scripts/smoke.mjs            Playwright end-to-end smoke
```

---

### Task 1: Project scaffold and geometry primitives

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts` (a placeholder that renders "Track Layout"), `src/geom/vec.ts`, `src/geom/path.ts`
- Test: `tests/geom/vec.test.ts`, `tests/geom/path.test.ts`

**Interfaces:**
- Produces, from `src/geom/vec.ts`:
  - `interface Vec2 { x: number; y: number }`
  - `interface Pose { x: number; y: number; rot: number }`
  - `add`, `sub`, `scale(v, k)`, `len`, `dist(a, b)`, `fromAngle(deg): Vec2`, `rotate(v, deg): Vec2`
  - `normDeg(a): number`, which returns a value in (−180, 180]
  - `angleDiff(a, b): number`, which returns the absolute normalised difference
  - `applyPose(pose, local: Vec2): Vec2`, `composePose(parent: Pose, local: Pose): Pose`, `invertPose(p): Pose`
  - `approxEq(a: number, b: number, eps = 1e-9): boolean`
- Produces, from `src/geom/path.ts`:
  - `type Segment = { kind: 'line'; from: Vec2; heading: number; length: number } | { kind: 'arc'; from: Vec2; heading: number; radius: number; sweep: number }`
  - `type PathStep = { line: number } | { arc: { radius: number; sweep: number } }`
  - `interface RoutePath { segments: Segment[]; length: number }`
  - `makePath(start: Vec2, heading: number, steps: PathStep[]): RoutePath`
  - `samplePath(p: RoutePath, d: number): { pos: Vec2; heading: number }`. It clamps `d` to `[0, length]`. The heading points in the direction of travel from start to end.
  - `pathEnd(p): { pos: Vec2; heading: number }`
  - `transformPath(p: RoutePath, pose: Pose): RoutePath`
  - `mirrorPath(p: RoutePath): RoutePath`, which reflects across the x-axis (y → −y, heading → −heading, sweep → −sweep)

- [ ] **Step 1: Scaffold.** Run `npm init -y` and add dev dependencies `vite`, `typescript` and `vitest` (latest stable). Add these scripts: `"dev": "vite"`, `"build": "tsc --noEmit && vite build"`, `"test": "vitest run"`. Use a tsconfig with `strict`, `target ES2022`, `module ESNext` and `moduleResolution bundler`. `index.html` contains `<div id="app">` and loads `/src/main.ts`.
- [ ] **Step 2: Write the failing tests**

```ts
// tests/geom/vec.test.ts
test('normDeg wraps into (-180,180]', () => { expect(normDeg(540)).toBe(180); expect(normDeg(-190)).toBe(170); });
test('applyPose rotates then translates', () => {
  const p = applyPose({ x: 1, y: 2, rot: 90 }, { x: 1, y: 0 });
  expect(p.x).toBeCloseTo(1); expect(p.y).toBeCloseTo(3);
});
test('composePose then invertPose is identity', () => {
  const a = { x: 3, y: -1, rot: 30 }, b = { x: 0.5, y: 2, rot: -75 };
  const c = composePose(invertPose(a), composePose(a, b));
  expect(c.x).toBeCloseTo(b.x); expect(c.y).toBeCloseTo(b.y); expect(normDeg(c.rot)).toBeCloseTo(b.rot);
});
// tests/geom/path.test.ts
test('right 90° arc of radius 1 from origin heading 0 ends at (1,1) heading 90', () => {
  const e = pathEnd(makePath({ x: 0, y: 0 }, 0, [{ arc: { radius: 1, sweep: 90 } }]));
  expect(e.pos.x).toBeCloseTo(1); expect(e.pos.y).toBeCloseTo(1); expect(e.heading).toBeCloseTo(90);
});
test('path length sums segments', () => {
  const p = makePath({ x: 0, y: 0 }, 0, [{ line: 1 }, { arc: { radius: 2, sweep: -45 } }]);
  expect(p.length).toBeCloseTo(1 + Math.PI / 2);
});
test('samplePath midpoint of a line', () => {
  expect(samplePath(makePath({ x: 0, y: 0 }, 90, [{ line: 2 }]), 1).pos.y).toBeCloseTo(1);
});
test('mirrorPath flips a right turn into a left turn', () => {
  const e = pathEnd(mirrorPath(makePath({ x: 0, y: 0 }, 0, [{ arc: { radius: 1, sweep: 90 } }])));
  expect(e.pos.y).toBeCloseTo(-1); expect(e.heading).toBeCloseTo(-90);
});
```

- [ ] **Step 3: Run `npx vitest run tests/geom`.** Expected: FAIL (the modules don't exist).
- [ ] **Step 4: Implement `vec.ts` and `path.ts`** to the interfaces above.
- [ ] **Step 5: Run `npx vitest run tests/geom && npm run build`.** Expected: PASS, and the build succeeds.
- [ ] **Step 6: Commit** with `feat: scaffold project and geometry primitives`.

---

### Task 2: Piece catalogue with exact-closing geometry

**Files:**
- Create: `src/track/catalog.ts`
- Test: `tests/track/catalog.test.ts`, plus `tests/helpers/chain.ts`, a test helper that chains pieces connector-to-connector

**Geometry decisions** (spec §5.3, "catalogue geometry must close exactly"):
- **Radii:**
  - `R_M = Math.SQRT2`, so a 45° medium curve advances exactly 1U forward.
  - `D = 2 * (Math.SQRT2 - 1)` (≈ 0.828) is the parallel-track spacing.
  - `R_S = R_M - D` (≈ 0.586) and `R_L = R_M + D` (≈ 2.243).
- **Switches:** a switch's straight route is 1U long, and its branch is exactly a `curve-m-45` path. A switch followed by a reverse `curve-m-45` therefore lands on a parallel track D away and 2U forward.
- **Diagonal straights:** `straight-d1` (length √2) and `straight-d1-2` (length √2/2). Laid at 45°, they span exactly one grid cell (1U × 1U) or half a cell diagonally.
- **`crossover-90`:** two straight routes of length √2 crossing at the centre, so each arm is √2/2.
- **Piece frame:** each piece's local origin is at connector 0, and the piece extends along local +x. Connector 0 therefore has outward heading 180. Every other connector's outward heading equals the heading of travel at the end of its route.
- **Mirroring:** curves and switches are defined turning **right**. `flipped: true` mirrors them with `mirrorPath` and negates connector y and heading.
- **Tunnels (plan call):** a tunnel is a track-piece variant with a `tunnel` flag. The renderer draws a cover over it. That keeps snapping uniform.

**Catalogue** (type ids are stable, because they appear in save files):

| type | routes / notes |
|---|---|
| `straight-1-4`, `straight-1-2`, `straight-1`, `straight-2` | one line route, lengths ¼, ½, 1 and 2 |
| `straight-d1-2`, `straight-d1` | line routes, lengths √2/2 and √2 |
| `curve-s-45`, `curve-m-45`, `curve-l-45`, `curve-l-22` | one right arc: R_S/45°, R_M/45°, R_L/45° and R_L/22.5° |
| `switch` | entry conn 0; route 0 is a line of 1 (to conn 1); route 1 is a `curve-m-45` arc (to conn 2); `switch: { entry: 0, routes: [0, 1] }`; flippable |
| `switch-y` | entry conn 0; route 0 is a left `curve-m-45` arc, route 1 is a right `curve-m-45` arc |
| `crossover-90` | two line routes of √2 crossing at the midpoint at 90° (four connectors) |
| `crossover-45` | two line routes of 1 crossing at the midpoint at 45° |
| `ramp-2` | a line of 2; conn 1 has `levelOffset: 1`; `ramp: true` |
| `bridge-1`, `bridge-2` | lines of 1 and 2; `bridge: true` (drawn with deck and supports at any level) |
| `tunnel-1`, `tunnel-2`, `tunnel-m-45` | like straight-1, straight-2 and curve-m-45, with `tunnel: true` |
| `buffer` | one connector (conn 0); route 0 is a line of 0.5 from conn 0 to `to: null` (a dead end) |

**Interfaces:**
- Consumes: `vec.ts`, `path.ts` (Task 1).
- Produces:
  - Constants: `R_S, R_M, R_L, D`
  - `type Family = 'straight'|'curve'|'switch'|'crossover'|'ramp'|'bridge'|'tunnel'|'buffer'`
  - `interface ConnectorDef { pos: Vec2; heading: number; levelOffset: 0 | 1; gender: 'm' | 'f' }`
  - `interface RouteDef { from: number; to: number | null; path: RoutePath }`, where the path is in local coordinates and runs from `from` to `to`
  - `interface PieceDef { type: string; family: Family; label: string; connectors: ConnectorDef[]; routes: RouteDef[]; switch?: { entry: number; routes: [number, number] }; footprint: Vec2[]; flippable: boolean; ramp?: true; bridge?: true; tunnel?: true }`
    - `footprint` is a local polygon: the track band, 0.5U wide, around all routes.
  - `CATALOG: Readonly<Record<string, PieceDef>>`, `PALETTE_ORDER: string[]`
  - `getPieceDef(type: string): PieceDef`, which throws `Error('Unknown piece type: ' + type)`
  - `pieceConnectors(type: string, flipped: boolean): ConnectorDef[]`, `pieceRoutes(type: string, flipped: boolean): RouteDef[]`, which return mirrored copies when flipped

- [ ] **Step 1: Write the test helper.** In `tests/helpers/chain.ts`, add `chain(start: Pose, steps: Array<{ type: string; flipped?: boolean; enter?: number; exit?: number }>): Pose`. Each step attaches the piece's `enter` connector (default 0) to the current pose, then moves the current pose to the world pose of the `exit` connector (default 1). The helper returns the final pose, with the heading pointing outward.
- [ ] **Step 2: Write the failing tests**

```ts
const closes = (end: Pose, start: Pose) => {
  expect(dist(end, start)).toBeLessThan(1e-9);
  expect(angleDiff(end.rot, start.rot + 180)).toBeLessThan(1e-9);
};
const O = { x: 0, y: 0, rot: 180 }; // outward heading of a virtual connector at the origin
test('8 medium curves make a circle', () => closes(chain(O, Array(8).fill({ type: 'curve-m-45' })), O));
test('each radius closes in 8 (or 16 for 22.5°)', () => {
  for (const t of ['curve-s-45', 'curve-l-45']) closes(chain(O, Array(8).fill({ type: t })), O);
  closes(chain(O, Array(16).fill({ type: 'curve-l-22' })), O);
});
test('oval: 4 curves, 2 straight-2, 4 curves, 2 straight-2', () => {
  const c = { type: 'curve-m-45' }, s = { type: 'straight-2' };
  closes(chain(O, [s, s, c, c, c, c, s, s, c, c, c, c]), O);
});
test('concentric medium and large curves are D apart', () => {
  const inner = chain(O, Array(4).fill({ type: 'curve-m-45' }));
  const outer = chain({ x: 0, y: -D, rot: 180 }, Array(4).fill({ type: 'curve-l-45' }));
  expect(dist(inner, outer)).toBeCloseTo(D);
});
test('passing loop closes: switch + reverse curve vs main straights', () => {
  const branch = chain(O, [{ type: 'switch', exit: 2 }, { type: 'curve-m-45', flipped: true }]);
  const main = chain(O, [{ type: 'switch', exit: 1 }, { type: 'straight-1' }]);
  expect(branch.x).toBeCloseTo(main.x); expect(branch.y - main.y).toBeCloseTo(D); expect(normDeg(branch.rot)).toBeCloseTo(normDeg(main.rot));
});
test('figure-eight: crossover-90 at 45°, two lobes of diag-half + 6 curves + diag-half', () => {
  // lobe leaves the crossover's exit arm and comes back into the perpendicular arm; build both and assert each closes
  const lobe = [{ type: 'straight-d1-2' }, ...Array(6).fill({ type: 'curve-m-45', flipped: true }), { type: 'straight-d1-2' }];
  const xo = getPieceDef('crossover-90');
  // the implementer derives the arm poses from xo.connectors; each lobe must start at one arm and end exactly at the next arm (opposite heading)
  expect(xo.connectors).toHaveLength(4);
  expect(lobe).toHaveLength(8);
});
test('raised oval: ramp up and ramp down on one side match 2×straight-2 on the other', () => {
  const c = { type: 'curve-m-45' };
  closes(chain(O, [{ type: 'straight-2' }, { type: 'straight-2' }, c, c, c, c, { type: 'ramp-2' }, { type: 'ramp-2', enter: 1, exit: 0 }, c, c, c, c]), O);
});
test('unknown type throws', () => expect(() => getPieceDef('nope')).toThrow('Unknown piece type: nope'));
test('switch branch path equals curve-m-45 path', () => {
  expect(pathEnd(getPieceDef('switch').routes[1].path)).toEqual(pathEnd(getPieceDef('curve-m-45').routes[0].path));
});
```

The figure-eight test must be completed so that it builds both lobes from the crossover's arm connector poses and asserts closure with `closes`. The skeleton above fixes the pieces that make up the lobe.

- [ ] **Step 3: Run `npx vitest run tests/track/catalog.test.ts`.** Expected: FAIL.
- [ ] **Step 4: Implement `catalog.ts`.** Build every route with `makePath` from the table, and derive connector poses from the path ends so that they can't drift.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** with `feat: piece catalogue with exact-closing geometry`.

---

### Task 3: Model, Doc and track graph (auto-join, near-misses, overlaps)

**Files:**
- Create: `src/model/types.ts`, `src/model/doc.ts`, `src/track/graph.ts`
- Test: `tests/track/graph.test.ts`

**Interfaces:**
- Consumes: the catalogue (Task 2).
- Produces, from `model/types.ts`:
  - `type StyleId = 'wooden' | 'model' | 'brick'`
  - `interface SwitchSettings { mode: 'manual' | 'auto'; state: 0 | 1 }`
  - `interface Piece { id: string; type: string; x: number; y: number; rot: number; level: number; flipped: boolean; switch?: SwitchSettings }`
  - `interface TrackPos { pieceId: string; route: number; dist: number; dir: 1 | -1 }`, where `dist` is measured from the route's `from` connector, and `dir: 1` means travel from→to
  - `interface Train { id: string; cars: number; color: string; speed: number; running: boolean; head: TrackPos | null; lifted: Pose | null; currentSpeed: number; crashed: boolean; crashAt: Vec2 | null }`. A train is lifted exactly when `head === null`.
  - `interface Settings { collisions: boolean; hillEffect: boolean; gridVisible: boolean }`
  - `interface Layout { style: StyleId; settings: Settings; pieces: Piece[]; trains: Train[] }`
  - `MAX_LEVEL = 3`, `MAX_CARS = 20`, `emptyLayout(): Layout`
- Produces, from `model/doc.ts`:
  - `class Doc { layout: Layout; graph: TrackGraph; constructor(layout: Layout); rebuild(): void; piece(id): Piece | undefined; train(id): Train | undefined; newId(prefix: 'p' | 't'): string }`
  - `newId` returns an id that isn't already in use.
- Produces, from `track/graph.ts`:
  - `interface WorldConnector { pieceId: string; index: number; pos: Vec2; heading: number; level: number }`
  - `connKey(pieceId, index): string`
  - `interface TrackGraph { joins: Map<string, WorldConnector>; open: WorldConnector[]; nearMisses: Array<[WorldConnector, WorldConnector]>; overlaps: Array<[string, string]> }`
  - `JOIN_POS_TOL = 0.01`, `JOIN_ANGLE_TOL = 1`, `NEAR_POS_TOL = 0.25`, `NEAR_ANGLE_TOL = 15`
  - `worldConnectors(p: Piece): WorldConnector[]`
  - `worldRoutePath(p: Piece, route: number): RoutePath`
  - `worldFootprint(p: Piece): Vec2[]`
  - `buildGraph(pieces: Piece[]): TrackGraph`

**Rules:**
- **Join:** two connectors join when they are on different pieces, on the same level, within `JOIN_POS_TOL` of each other, and their headings differ by 180 within `JOIN_ANGLE_TOL`.
- **Deterministic pairing:** sort candidate pairs by (distance, then the pair's keys in lexicographic order) and take them greedily, using each connector at most once.
- **Near miss:** an unjoined pair on the same level within `NEAR_POS_TOL` and `NEAR_ANGLE_TOL` of opposite headings, but not joinable.
- **Overlap:** two same-level pieces whose footprints intersect, other than pieces joined to each other. Use polygon intersection by SAT on convex parts, or by sampling route points; this is the implementer's choice. Crossovers overlapping themselves are not flagged.
- **Performance:** use a uniform spatial hash with cell size 1U, so 1,000 pieces still rebuild in under 50 ms.

- [ ] **Step 1: Write the failing tests**

```ts
const P = (id: string, type: string, x: number, y: number, rot = 0, level = 0): Piece => ({ id, type, x, y, rot, level, flipped: false });
test('two straights end to end join', () => {
  const g = buildGraph([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0)]);
  expect(g.joins.get(connKey('a', 1))?.pieceId).toBe('b'); expect(g.open).toHaveLength(2);
});
test('different levels never join', () => {
  expect(buildGraph([P('a', 'straight-1', 0, 0, 0, 0), P('b', 'straight-1', 1, 0, 0, 1)]).joins.size).toBe(0);
});
test('a ramp high end joins level+1', () => {
  expect(buildGraph([P('r', 'ramp-2', 0, 0, 0, 0), P('b', 'straight-1', 2, 0, 0, 1)]).joins.size).toBe(2);
});
test('0.1U gap is a near miss, not a join', () => {
  const g = buildGraph([P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1.1, 0)]);
  expect(g.joins.size).toBe(0); expect(g.nearMisses).toHaveLength(1);
});
test('a closed circle of 8 curves has no open connectors', () => { /* build with chain poses from Task 2 helper */ });
test('three connectors at one point: exactly one pair joins, deterministically', () => {
  const ps = [P('a', 'straight-1', 0, 0), P('b', 'straight-1', 1, 0), P('c', 'straight-1', 1, 0)];
  const g1 = buildGraph(ps), g2 = buildGraph([...ps].reverse());
  expect(g1.joins.size).toBe(2); expect([...g1.joins.keys()].sort()).toEqual([...g2.joins.keys()].sort());
});
test('crossing straights at same level overlap; at different levels they do not', () => {
  expect(buildGraph([P('a', 'straight-2', 0, 0), P('b', 'straight-2', 1, -1, 90)]).overlaps).toHaveLength(1);
  expect(buildGraph([P('a', 'straight-2', 0, 0), P('b', 'straight-2', 1, -1, 90, 1)]).overlaps).toHaveLength(0);
});
test('Doc.newId never collides', () => {
  const d = new Doc({ ...emptyLayout(), pieces: [P('p1', 'straight-1', 0, 0)] });
  expect(d.newId('p')).not.toBe('p1');
});
```

- [ ] **Step 2: Run `npx vitest run tests/track/graph.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** `types.ts`, `doc.ts` and `graph.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: layout model and track graph with auto-join`.

---

### Task 4: Save, load and autosave

**Files:**
- Create: `src/io/serialize.ts`
- Test: `tests/io/serialize.test.ts`

**Interfaces:**
- Consumes: `Layout` and `getPieceDef`.
- Produces:
  - `FORMAT = 'track-layout'`, `VERSION = 1`, `AUTOSAVE_KEY = 'track-layout:autosave'`
  - `serialize(layout: Layout): string`
  - `deserialize(text: string): { ok: true; layout: Layout } | { ok: false; error: string }`
  - `saveAutosave(layout: Layout, storage?: Storage): void`, `loadAutosave(storage?: Storage): Layout | null`. Both wrap storage access in try/catch, and `storage` defaults to `localStorage`.

**File shape** (spec §5.11):
- Top level: `{ format, version, style, settings, pieces, trains }`.
- Each piece: `{ id, type, x, y, rotation, level, flipped, switch? }`.
- Each train: `{ id, cars, color, speed, running, head: { piece, route, distance, direction: 'forward' | 'backward' } | null, lifted: { x, y, rotation } | null }`.
- Transient fields (`currentSpeed`, `crashed`, `crashAt`) are not written. On load they are reset to `0`, `false` and `null`.
- Numbers are rounded to 6 decimals when written.

**Validation errors** (the message names the problem, for example `Piece #3: unknown type "foo"`):
- wrong `format`
- `version` > 1
- a non-array `pieces` or `trains`
- duplicate ids across pieces and trains
- an unknown type
- non-finite numbers
- a `level` that isn't an integer in 0..`MAX_LEVEL`
- a `cars` value that isn't an integer in 0..`MAX_CARS`
- a train `head` pointing at a missing piece or route
- a `switch` block on a piece without a switch, or a bad `mode` or `state`

**Defaults when loading:**
- A missing `settings` field is filled with the defaults.
- A switch piece without a `switch` block gets `{ mode: 'manual', state: 0 }`.

- [ ] **Step 1: Write the failing tests**

```ts
test('round trip preserves pieces, trains, settings, style', () => { /* build layout with a switch (auto, state 1), a running train, a lifted train; expect deserialize(serialize(l)).layout toEqual l (transients reset) */ });
test('output is pretty-printed and contains no join data', () => {
  const s = serialize(emptyLayout()); expect(s).toContain('\n  "format": "track-layout"'); expect(s).not.toMatch(/join/i);
});
test.each([
  ['{}', /format/],
  ['{"format":"track-layout","version":2,"pieces":[],"trains":[]}', /version/],
  [dupIds, /duplicate id "p1"/],
  [unknownType, /unknown type "foo"/],
  [nanCoord, /x/],
  [trainBadRef, /missing piece/],
  ['not json', /JSON/],
])('rejects bad file %#', (text, msg) => {
  const r = deserialize(text); expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(msg);
});
test('missing settings get defaults (collisions on, hills off, grid on)', () => { /* … */ });
test('autosave survives a throwing storage', () => {
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } as unknown as Storage;
  expect(() => saveAutosave(emptyLayout(), bad)).not.toThrow(); expect(loadAutosave(bad)).toBeNull();
});
```

(`dupIds`, `unknownType`, `nanCoord` and `trainBadRef` are small fixture strings defined in the test file.)

- [ ] **Step 2: Run `npx vitest run tests/io`.** Expected: FAIL.
- [ ] **Step 3: Implement `serialize.ts`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: JSON save/load with validation and autosave`.

---

### Task 5: Track motion: positions, routing through switches, car poses, occupancy

**Files:**
- Create: `src/sim/motion.ts`
- Test: `tests/sim/motion.test.ts`

**Interfaces:**
- Consumes: `Doc`, `worldRoutePath`, `TrackGraph.joins`, `pieceRoutes`.
- Produces:
  - `LOCO_LEN = 1.0`, `CAR_LEN = 0.8`, `COUPLING = 0.1`, `CAR_WIDTH = 0.45`
  - `trainLength(cars: number): number`, equal to `LOCO_LEN + cars * (CAR_LEN + COUPLING)`
  - `interface AdvanceResult { pos: TrackPos; moved: number; hitEnd: boolean; entered: Array<{ pieceId: string; viaConnector: number; facing: boolean }> }`
  - `advance(doc: Doc, pos: TrackPos, ds: number, opts: { alignTrailing: boolean }): AdvanceResult`, where `ds ≥ 0` and the move is along `pos.dir`
  - `walkBack(doc: Doc, pos: TrackPos, ds: number): TrackPos`, which moves against `pos.dir` without changing any switches and stops at a dead end
  - `poseAt(doc: Doc, pos: TrackPos): { pos: Vec2; heading: number; level: number }`. The heading is the direction of travel. On a ramp, the level is `piece.level + (fraction > 0.5 ? 1 : 0)`.
  - `interface CarPose { center: Vec2; heading: number; length: number; level: number; isLoco: boolean; pieceIds: string[] }`
  - `carPoses(doc: Doc, train: Train): CarPose[]`, with the locomotive first
  - `occupiedPieces(doc: Doc, train: Train): Set<string>`
  - `distanceAhead(doc: Doc, pos: TrackPos, max: number): number`, which returns the distance to the next dead end, capped at `max`, following current switch states
  - `reverseHead(doc: Doc, train: Train): TrackPos`, which returns the tail position with the direction flipped
  - `routeEntering(doc: Doc, pieceId: string, connector: number): { route: number; dir: 1 | -1; facing: boolean }`

**Routing rules** (spec §5.6):
- **Leaving a route:** a train leaving through connector c looks up `joins.get(connKey(piece, c))`. If there's no join, it is a dead end: `hitEnd`, and the position is clamped to the route end.
- **Entering a switch at its `entry` connector (facing):** the route is `switch.routes[state]`.
- **Entering a switch at a branch (trailing):** the route is the one containing that connector. If `alignTrailing` is set, the switch's `state` is set to match.
- **Any other piece:** the unique route containing that connector. A crossover has two routes, each with distinct connectors.
- **Buffer stop:** `to: null` is the end of the track, so `hitEnd` triggers when the train reaches `route.length`.

- [ ] **Step 1: Write the failing tests**

```ts
test('advance crosses from one straight into the next', () => { /* a→b straight-1s, start a dist 0.5 dir 1, advance 1 → b dist 0.5 */ });
test('advance stops at an open end with hitEnd', () => { /* single straight-1, advance 5 → dist 1, hitEnd true, moved 0.5 */ });
test('facing switch follows its state', () => { /* straight→switch(state 1)→…; advance through → route 1 */ });
test('trailing switch aligns itself when alignTrailing', () => { /* enter via conn 2 with state 0 → state becomes 1; with alignTrailing false state unchanged */ });
test('circle of 8 curves: advancing one full circumference returns to start', () => { /* 8·(π·R_M/4) */ });
test('carPoses for 3 cars returns 4 poses spaced by trainLength pieces', () => {
  /* on a long straight: centre distance loco→car1 = LOCO_LEN/2 + COUPLING + CAR_LEN/2 */
});
test('reverseHead puts head at former tail, dir flipped', () => { /* … */ });
test('occupiedPieces lists every piece a car overlaps', () => { /* … */ });
test('distanceAhead stops at a buffer', () => { /* straight-1 → buffer: from start = 1 + 0.5 */ });
```

- [ ] **Step 2: Run `npx vitest run tests/sim/motion.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `motion.ts`.** Walk route by route in a loop, so that a large `ds` crossing many pieces works.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: train motion along track with switch routing`.

---

### Task 6: Command history and piece edit commands

**Files:**
- Create: `src/editor/history.ts`, `src/editor/commands.ts` (the piece commands now; train commands are added in Task 10)
- Test: `tests/editor/history.test.ts`, `tests/editor/commands.test.ts`

**Interfaces:**
- Consumes: `Doc` (every command calls `doc.rebuild()` after mutating).
- Produces:
  - `interface Command { label: string; do(doc: Doc): void; undo(doc: Doc): void }`
  - `class History { constructor(limit = 200); exec(cmd: Command, doc: Doc): void; undo(doc: Doc): boolean; redo(doc: Doc): boolean; get canUndo(): boolean; get canRedo(): boolean; clear(): void; onChange?: () => void }`
    - `exec` clears the redo stack.
    - When the stack exceeds `limit`, the oldest entry is dropped.
  - `placePieces(pieces: Piece[]): Command`
  - `transformPieces(ids: string[], next: Map<string, { x: number; y: number; rot: number; flipped?: boolean }>): Command`, used for move, rotate and flip
  - `deletePieces(ids: string[]): Command`
  - `setSwitchMode(id: string, mode: 'manual' | 'auto'): Command`
  - `batch(label: string, cmds: Command[]): Command`
- Each command stores full before and after snapshots of the pieces it touches, so `undo` is exact.

- [ ] **Step 1: Write the failing tests**

```ts
test('exec/undo/redo place', () => { /* place 1 piece; undo → 0 pieces; redo → 1 */ });
test('exec after undo clears redo', () => { /* … expect(h.canRedo).toBe(false) */ });
test('limit 200 drops oldest', () => { /* 201 execs, 200 undos succeed, 201st returns false */ });
test('transformPieces moves a group in one undo step', () => { /* 3 pieces, one undo restores all */ });
test('deletePieces undo restores ids, order and switch settings', () => { /* … */ });
test('graph is rebuilt after undo (joins reappear)', () => { /* place 2 joined, delete one, undo → joins.size 2 */ });
test('setSwitchMode is undoable', () => { /* manual→auto→undo→manual */ });
```

- [ ] **Step 2: Run `npx vitest run tests/editor`.** Expected: FAIL.
- [ ] **Step 3: Implement** `history.ts` and the piece commands.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: undoable piece edit commands`.

---

### Task 7: Snapping and ghost placement

**Files:**
- Create: `src/editor/snapping.ts`
- Test: `tests/editor/snapping.test.ts`

**Interfaces:**
- Consumes: `Doc`, `graph.open`, `pieceConnectors`.
- Produces:
  - `GRID = 0.5`, `ROT_STEP = 22.5`
  - `interface GhostRequest { type: string; flipped: boolean; attachIndex: number; cursor: Vec2; freeRot: number; level: number; alt: boolean; snapRadius: number; prefer?: WorldConnector }`
  - `interface GhostResult { pose: Pose; level: number; mode: 'connector' | 'grid' | 'free'; target?: WorldConnector; attachIndex: number }`
  - `computeGhost(doc: Doc, req: GhostRequest): GhostResult`
  - `interface GroupSnap { delta: Vec2; rot: number; pivot: Vec2 }`
  - `snapGroup(doc: Doc, ids: string[], proposed: GroupSnap, snapRadius: number, alt: boolean): GroupSnap`
  - `posesAfterGroup(doc: Doc, ids: string[], g: GroupSnap): Map<string, Pose>`

**Rules** (spec §5.3):
- **`attachIndex`** is taken modulo the connector count, and the normalised value is returned.
- **Alt held:** free placement: `pose = { cursor, rot: freeRot }`, at `req.level`.
- **Otherwise, connector snap first:**
  - If `prefer` is set and the cursor is within `3 * snapRadius` of it, attach to `prefer`.
  - Otherwise, attach to the nearest open connector within `snapRadius`.
  - The ghost connector `attachIndex` is placed at the target's position with the opposite heading. The ghost's level is the target level minus the attached connector's `levelOffset`. Reject the target if that level would be below 0 or above `MAX_LEVEL`.
- **Otherwise, grid snap:** the origin rounds to a multiple of `GRID`, the rotation rounds to `ROT_STEP`, and the level is `req.level`.
- **`snapGroup`:** checks each open connector of the selected pieces (after the proposed transform) against open connectors of unselected pieces. The nearest compatible pair within `snapRadius` determines the correction: the rotation snaps to make the headings exactly opposite, then the translation closes the gap. With `alt`, the proposal is returned unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test('snaps curve to an open straight end', () => { /* straight-1 at 0,0; cursor (1.05,0.02) → mode connector, pose x 1 y 0 rot 0 */ });
test('Tab cycles attachIndex modulo connector count', () => { /* switch attachIndex 4 → 1 */ });
test('falls back to grid: origin multiple of 0.5, rot multiple of 22.5', () => { /* cursor (3.3, 1.8), freeRot 50 → (3.5, 2) rot 45 */ });
test('alt gives free placement exactly at cursor', () => { /* … */ });
test('attaching to a ramp high end puts the ghost at level+1', () => { /* … */ });
test('prefer wins within 3× radius even if another connector is nearer', () => { /* … */ });
test('snapGroup aligns a dragged straight to a neighbour within radius', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/editor/snapping.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `snapping.ts`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: connector, grid and free snapping`.

---

### Task 8: Simulation step: speeds, dead ends, auto switches, hill effect

**Files:**
- Create: `src/sim/simulation.ts`
- Test: `tests/sim/simulation.test.ts`

**Interfaces:**
- Consumes: `motion.ts` (Task 5) and `Doc`. Collision handling plugs in during Task 9 through the `checkCollisions` call site.
- Produces:
  - `ACCEL = 1.5` (U/s²), `STEP = 1 / 120`, `MAX_DT = 0.25`, `HILL_FACTOR = 0.35`
  - `class Simulation { constructor(doc: Doc); paused: boolean; step(dt: number): void; toggleSwitch(pieceId: string): boolean; canToggle(pieceId: string): boolean; reverse(trainId: string): void; forget(trainId: string): void }`
    - `step` clamps `dt` to `MAX_DT`, then runs `Math.ceil(dt / STEP)` substeps. When `paused` it does nothing.
    - `toggleSwitch` returns false, and changes nothing, if any train occupies the switch.
    - `reverse` sets `head = reverseHead`, `currentSpeed = 0` and clears `crashed`.
    - `forget` drops per-train internal state when a train is deleted or lifted.

**Per substep, for each non-lifted train:**
1. **Target speed:**
   - Zero if the train isn't running or is crashed.
   - Otherwise its set `speed`, times `1 - HILL_FACTOR` on a ramp travelling up (from the `levelOffset 0` end toward `levelOffset 1`), or `1 + HILL_FACTOR` travelling down. Only when `settings.hillEffect` is on.
   - **Dead-end braking:** if `distanceAhead(head, v²/(2·ACCEL) + 0.01)` is at most `v²/(2·ACCEL)`, the target is 0.
2. **Speed change:** `currentSpeed` moves toward the target by at most `ACCEL·h`.
3. **Move:** `advance(head, currentSpeed·h, { alignTrailing: true })`. On `hitEnd`, `currentSpeed = 0`. The train stays `running` but doesn't move.
4. **Facing switches:** each `entered` with `facing` on an `auto` switch is recorded as a pending flip.
5. **Pending flips** happen once no train occupies the switch.

Then `checkCollisions(doc)` runs (a no-op stub until Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
test('train accelerates at ACCEL up to set speed', () => { /* speed 2: after 0.5s currentSpeed ≈ 0.75; after 3s = 2 */ });
test('train brakes and stops exactly at a buffer without passing it', () => { /* final dist ≤ route length, currentSpeed 0 */ });
test('huge dt is clamped: one step(600) moves at most speed·MAX_DT', () => { /* … */ });
test('paused simulation does not move trains', () => { /* … */ });
test('auto switch flips only after the tail clears', () => { /* state unchanged while occupied; flips after */ });
test('auto switch waits while a second train occupies it', () => { /* … */ });
test('toggleSwitch refused while occupied', () => { /* returns false, state unchanged */ });
test('hill effect: uphill slower, downhill faster, never zero; off = no change', () => {
  /* on ramp uphill steady speed ≈ speed·0.65; downhill ≈ speed·1.35 */
});
test('reverse swaps head to tail and clears crash', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/sim/simulation.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `simulation.ts`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: fixed-step train simulation with switches and hills`.

---

### Task 9: Collisions

**Files:**
- Create: `src/sim/collision.ts`
- Modify: `src/sim/simulation.ts`, replacing the stub call
- Test: `tests/sim/collision.test.ts`

**Interfaces:**
- Consumes: `carPoses` and `CAR_WIDTH`.
- Produces:
  - `carsOverlap(a: CarPose, b: CarPose): boolean`, using SAT on oriented rectangles (`length` × `CAR_WIDTH`), and false if the levels differ
  - `findCollisions(doc: Doc): Array<{ a: string; b: string; at: Vec2 }>`, which skips lifted trains, never pairs a train with itself, and uses a bounding-circle pre-check
  - `checkCollisions(doc: Doc): void`. When `settings.collisions` is on, for each pair it sets `running = false`, `currentSpeed = 0`, `crashed = true` and `crashAt = at` on both trains.

- [ ] **Step 1: Write the failing tests**

```ts
test('head-on trains on one straight crash and stop', () => { /* … both crashed, crashAt between them */ });
test('collisions off: trains pass through', () => { /* … */ });
test('train on a bridge (level 1) does not collide with one below', () => { /* … */ });
test('trains on a 90° crossover collide when both are on it', () => { /* … */ });
test('a train longer than its loop never collides with itself', () => {
  /* 8 medium curves, train with MAX_CARS cars running: after 10s not crashed and still moving */
});
test('a crashed train restarted forward stays crashed; reversed it moves away', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/sim/collision.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `collision.ts` and wire it into `Simulation.step`.**
- [ ] **Step 4: Run all tests with `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: train collisions with level awareness`.

---

### Task 10: Train commands and lifting trains on edits

**Files:**
- Modify: `src/editor/commands.ts`
- Test: `tests/editor/trainCommands.test.ts`

**Interfaces:**
- Consumes: `occupiedPieces`, `carPoses`, `findCollisions` style overlap checks (`carsOverlap`), `Simulation.forget`, `trainLength` and `distanceAhead`.
- Produces:
  - `placeTrain(train: Train): Command`
  - `moveTrain(id: string, head: TrackPos): Command`. This drops a lifted train back onto the track or relocates one, and also clears `crashed`.
  - `deleteTrains(ids: string[]): Command`
  - `setTrainProps(id: string, props: Partial<Pick<Train, 'cars' | 'color'>>): Command`
  - `canPlaceTrain(doc: Doc, head: TrackPos, cars: number): boolean`, which is false if walking back by `trainLength(cars)` hits a dead end first
  - `withLifting(doc: Doc, pieceIds: string[], inner: Command): Command`. It wraps a piece edit: on `do`, every train occupying any of `pieceIds` is lifted (`lifted = pose of loco`, `head = null`, `running = false`, `currentSpeed = 0`) before `inner.do`.
- In `ui/app.ts`, `transformPieces` and `deletePieces` are always issued through `withLifting`.

**Undo rules** (spec §5.5a):
- `withLifting.undo` runs `inner.undo`, then, for each train it lifted, checks whether that train is still lifted.
- If the train's recorded `head` is valid again (the piece and route exist) and its cars wouldn't overlap any other non-lifted train, it is restored **stopped** (`running = false`).
- Otherwise it stays lifted.
- Redo lifts the train again.

- [ ] **Step 1: Write the failing tests**

```ts
test('placeTrain refused (canPlaceTrain false) when the train would hang off an end', () => { /* … */ });
test('deleting a piece under a train lifts it, not deletes it', () => { /* train.head null, lifted pose set, trains.length unchanged */ });
test('moving a piece under a train lifts it; untouched trains keep running', () => { /* … */ });
test('undo restores a lifted train in place, stopped', () => { /* running was true → after undo head equal, running false */ });
test('undo leaves the train lifted if another train now occupies its spot', () => { /* … */ });
test('setTrainProps cars/color undoable', () => { /* … */ });
test('moveTrain clears crashed', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/editor/trainCommands.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** the train commands and `withLifting`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: train commands and lift-on-edit with undo`.

---

### Task 11: Renderer, camera and wooden style

**Files:**
- Create: `src/render/camera.ts`, `src/render/style.ts`, `src/render/styles/wooden.ts`, `src/render/renderer.ts`
- Test: `tests/render/camera.test.ts`, `tests/render/renderer.test.ts` (using a recording mock context)

**Interfaces:**
- Consumes: `Doc`, `carPoses`, `worldRoutePath`, `worldFootprint`, `pieceConnectors` and `TrackGraph`.
- Produces, from `camera.ts`:
  - `interface Camera { cx: number; cy: number; zoom: number }`, where `zoom` is pixels per U; the default is 80, clamped to 10..400
  - `worldToScreen(cam, size: Vec2, p: Vec2): Vec2`, `screenToWorld(cam, size: Vec2, p: Vec2): Vec2`
  - `zoomAt(cam, size, screenPt: Vec2, factor: number): Camera`, which keeps the world point under the cursor fixed
  - `fitBounds(cam, size, min: Vec2, max: Vec2): Camera`
- Produces, from `style.ts`:
  - `interface PieceDrawOpts { ghost?: boolean; selected?: boolean }`
  - `interface Style { id: StyleId; name: string; background(ctx, viewMin: Vec2, viewMax: Vec2, gridVisible: boolean): void; piece(ctx, piece: Piece, opts: PieceDrawOpts): void; tunnelCover(ctx, piece: Piece): void; car(ctx, car: CarPose, train: Train): void }`
  - All `Style` methods draw in **world units**; the renderer has already applied the camera transform.
  - Helpers: `strokeRoute(ctx, path: RoutePath, width: number)`, `connectorShape(ctx, conn: WorldConnector, gender)`
  - `STYLES: Record<StyleId, Style>`, filled in during Task 12; wooden only for now
- Produces, from `renderer.ts`:
  - `interface Overlay { selectedPieces: Set<string>; selectedTrain?: string; ghost?: { piece: Piece; valid: boolean }; ghostTrain?: CarPose[]; showConnectors: boolean }`
  - `render(ctx: CanvasRenderingContext2D, doc: Doc, cam: Camera, size: Vec2, overlay: Overlay, styleId: StyleId): void`

**Draw order:**
1. Background.
2. For each level L from 0 to `MAX_LEVEL`:
   - If L > 0, a shadow pass: level-L pieces filled with `rgba(0,0,0,0.25)`, offset by (0.06·L, 0.06·L).
   - The pieces at level L. Ramps are drawn in the L pass of their *low* level, after the other L pieces.
   - The switch-state indicator: an arrow along the active route.
   - The non-lifted cars at level L.
   - If L == 0, tunnel covers.
3. Lifted trains at 40% alpha.
4. Overlays:
   - open connectors, when `showConnectors` is on
   - near-miss markers: an orange ring, 0.15U, at each pair's midpoint
   - overlap highlight: a red translucent fill
   - selection outlines
   - crash markers: a red star at `crashAt`
   - the ghost: 50% alpha, with a red tint if invalid
   - the ghost train

**Wooden look:**
- Table: `#e8d3a9` with subtle plank lines.
- Track band: `#d9b27c`, 0.5U wide, with two darker grooves at ±0.12U.
- A peg (circle, r 0.07U) on male connectors, and a matching hole on female ones.
- Locomotive: rounded rectangle in the train colour, with a black chimney dot.
- Cars: rounded rectangles in a lighter tint, with wheel nubs.

**Tests:**
- Camera round-trips.
- `zoomAt` keeps the point under the cursor fixed.
- `render` with a mock context that records calls doesn't throw for every catalogue type, both flips, levels 0 to 3, and a train on a ramp.
- `fillRect` or `fill` is called for the background.
- The recorded draw order puts a level-1 piece's `fill` after a level-0 car's `fill`.

- [ ] **Step 1: Write the failing tests** described above. The mock is a `Proxy` that records method names and accepts any property.
- [ ] **Step 2: Run `npx vitest run tests/render`.** Expected: FAIL.
- [ ] **Step 3: Implement** camera, style helpers, the wooden style and the renderer.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Visual check.** Temporarily have `src/main.ts` draw a demo layout: an oval with a passing loop, a ramped bridge over the oval, a tunnel and two trains. Run `npm run dev`, take a Playwright screenshot at 1280×800, and confirm by looking at it that the grooves, pegs, shadow, tunnel cover and level order look right.
- [ ] **Step 6: Commit** with `feat: canvas renderer with wooden style`.

---

### Task 12: Model-train and toy-brick styles

**Files:**
- Create: `src/render/styles/model.ts`, `src/render/styles/brick.ts`
- Modify: `src/render/style.ts` (register all three in `STYLES`)
- Test: extend `tests/render/renderer.test.ts` to loop over all three style ids

**Model-train look:**
- Background: grass `#7da35a`.
- Track: a grey ballast bed (0.5U), brown sleepers every 0.15U across the route, and two steel rails (`#9aa0a6`) at ±0.1U.
- No visible pegs.
- Trains: slim, with darker roof lines.

**Toy-brick look:**
- Background: a green baseplate `#3a9a3a` with stud circles every 0.25U. Studs are drawn only when zoom is 30 or more, for performance.
- Track: a dark grey plate with studs, and light grey rail strips.
- Trains: blocky rectangles with studs on top.
- No logos and no trademarked names.

Each style must draw switch states, connectors (as a plain joint line in model and brick), tunnel covers (a stone portal in model, a brick arch in brick) and bridges (a deck plus supports).

- [ ] **Step 1: Extend the test to all three styles.** Run it and expect FAIL, because the styles are missing.
- [ ] **Step 2: Implement both styles.**
- [ ] **Step 3: Run `npm test`.** Expected: PASS.
- [ ] **Step 4: Visual check.** Take screenshots of the demo layout in each style and review them.
- [ ] **Step 5: Commit** with `feat: model-train and toy-brick styles`.

---

### Task 13: App shell, input, palette and toolbar

**Files:**
- Create: `src/ui/app.ts`, `src/ui/input.ts`, `src/ui/toolbar.ts`, `src/ui/palette.ts`
- Modify: `src/main.ts`, `index.html` (adding a CSS layout per spec §5.12: toolbar on top, palette on the left, canvas filling the rest)
- Test: `tests/ui/input.test.ts`, which drives `Input` with synthetic events against a real `Doc` and `History`. Use vitest `environment: 'jsdom'` for this file only, and add `jsdom` as a dev dependency. *(This is the one extra dev dependency; it is for tests only.)*

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `class App { doc: Doc; history: History; sim: Simulation; camera: Camera; style: StyleId; exec(cmd: Command): void; undo(): void; redo(): void; requestRender(): void; constructor(root: HTMLElement) }`
    - `exec`, `undo` and `redo` call `doc.rebuild()`, autosave (debounced 500 ms), and request a render.
    - The animation loop calls `sim.step(dt)` and then `render`.
    - In dev builds, `window.__app = app` is exposed for the smoke script.
  - `type Mode = { kind: 'select' } | { kind: 'place'; type: string; flipped: boolean; attachIndex: number; freeRot: number; prefer?: WorldConnector } | { kind: 'placeTrain'; cars: number; dir: 1 | -1 }`
  - `class Input { mode: Mode; constructor(app: App, canvas: HTMLCanvasElement); handleKey(e: KeyboardEvent): void; handlePointer(e: PointerEvent): void; handleWheel(e: WheelEvent): void }`
  - `buildPalette(app, el)`: one canvas thumbnail per catalogue entry, grouped by family and drawn with the current style. Clicking a thumbnail enters `place` mode. The palette also has an "+ Train" entry.
  - `buildToolbar(app, el)`: New, Open, Save, Undo, Redo, a Style select, a Level select (0..`MAX_LEVEL`), Collisions and Hills checkboxes, Grid, Fit, and Play/Pause. Undo and Redo are disabled per `history.canUndo` and `history.canRedo`.

**Input behaviour** (spec §5.3, §5.10):

*Place mode:*
- The ghost comes from `computeGhost` with `snapRadius = 12px / zoom`.
- Click: `exec(placePieces([...]))`. Then set `prefer` to the new piece's first open connector, so the ghost follows on (keep-placing).
- **Tab** changes `attachIndex`. **R** or the wheel flips the piece (if flippable) or steps `freeRot` by 22.5°. **Alt** places freely.
- **Esc** or right-click returns to select mode.

*Select mode:*
- Click selects; Shift-click toggles a piece in the selection; dragging on empty space draws a box select.
- Double-click selects the whole connected component.
- Dragging the selection previews with `snapGroup`, and on release issues one `withLifting(transformPieces)`.
- **Q** and **E** rotate the selection by ∓22.5° about its centroid. **Delete** or **Backspace** issues `withLifting(deletePieces)`.
- Clicking a switch with nothing selected and no drag calls `sim.toggleSwitch`. This is not undoable.

*placeTrain mode:*
- The ghost train sits along the nearest route within the snap radius. **Tab** flips its direction.
- Click: if `canPlaceTrain`, issue `placeTrain` with a new train (colour cycles through a fixed palette of 8, speed 1.5, not running). On a lifted selected train, issue `moveTrain` instead.

*View:*
- Middle-drag or Space+drag pans. The wheel zooms at the cursor (except while placing a flippable piece, when it flips instead).

*Keys:*
- Ctrl/Cmd-Z undoes. Ctrl/Cmd-Shift-Z and Ctrl-Y redo.
- **All shortcuts are ignored while the event target is an `input`, `select` or `textarea`.**

**Toolbar actions:**
- New: confirm if the history isn't empty, then load an empty layout and clear the history.
- Open: uses a file input. A failed `deserialize` shows `alert(error)` and keeps the current layout. On success it replaces the doc, clears the history and fits the view.
- Save: downloads `layout.json` with the `serialize` output.
- Dropping a `.json` file on the window behaves like Open.
- On start, load the autosave if there is one, otherwise an empty layout.

- [ ] **Step 1: Write the failing tests**

```ts
test('Ctrl-Z undoes the last placement', () => { /* place via place-mode click; dispatch keydown ctrlKey z → pieces 0 */ });
test('Ctrl-Z in a focused input does not undo', () => { /* target = input element → pieces still 1 */ });
test('keep-placing: second click attaches to the first piece', () => { /* two clicks at same cursor → 2 pieces joined */ });
test('Tab cycles attachIndex; Esc returns to select', () => { /* … */ });
test('Delete removes selection in one undo step', () => { /* select 2, Delete, Ctrl-Z → 2 back */ });
test('clicking a switch toggles it and does not add to history', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/ui`.** Expected: FAIL.
- [ ] **Step 3: Implement** the app, input, palette and toolbar.
- [ ] **Step 4: Run `npm test && npm run build`.** Expected: PASS.
- [ ] **Step 5: Manual check.** In `npm run dev`, build an oval by keep-placing, check that the loop closes with no open connectors, and press Ctrl-Z a few times.
- [ ] **Step 6: Commit** with `feat: editor UI with palette, toolbar and input`.

---

### Task 14: Train and switch panels, end-to-end smoke

**Files:**
- Create: `src/ui/panels.ts`, `scripts/smoke.mjs`
- Modify: `src/ui/app.ts` (show the panels when a train or switch is selected), `package.json` (`"smoke": "vite build && node scripts/smoke.mjs"`)

**Interfaces:**
- Consumes: `App`, `Simulation`, and the train and switch commands.
- Produces:
  - `showTrainPanel(app, trainId)`: a floating panel near the train with Run/Stop (toggles `running`, not undoable), Reverse (`sim.reverse`), a speed slider (0.2 to 4 U/s, not undoable), a car count number field (0 to 20, via `setTrainProps`), a colour input (via `setTrainProps`), and Delete (via `deleteTrains`). A lifted train shows a "Place back" button, which enters `placeTrain` mode targeting it.
  - `showSwitchPanel(app, pieceId)`: a manual/auto radio (via `setSwitchMode`).
  - `hidePanels()`

**`scripts/smoke.mjs`** starts `vite preview` on a free port, launches chromium (`require('playwright')`), and asserts each of the following through `window.__app`, exiting non-zero on any failure:
1. Click the `curve-m-45` palette tile, then click 8 times at the follow-on ghost. Check `doc.graph.open.length === 0`.
2. Enter "+ Train" and click on the track. Check there is 1 train. Set `running` from the panel's Run button, wait 1 s, and check the head position changed.
3. Press Ctrl-Z until the history is empty, then check `doc.layout.pieces.length === 0`.
4. Press Ctrl-Shift-Z once and check there is 1 piece.
5. Switch the style to each of the three styles and take a screenshot of each to `scripts/out/`. The page must have no console errors.

- [ ] **Step 1: Write `scripts/smoke.mjs`.** Run `npm run smoke` and expect FAIL, because there are no panels or train run button yet.
- [ ] **Step 2: Implement `panels.ts` and wire it in.**
- [ ] **Step 3: Run `npm test && npm run smoke`.** Expected: all pass, and three screenshots are written. Look at the screenshots.
- [ ] **Step 4: Commit** with `feat: train and switch panels, end-to-end smoke test`.

---

## Spec coverage map

| Spec § | Task(s) |
|---|---|
| 5.1 Architecture | 1, 3, 13 |
| 5.2 Piece catalogue, gender drawn not enforced | 2, 11 |
| 5.3 Snapping, auto-join, near-miss, keep-placing, selection, view, overlaps | 3, 7, 13 |
| 5.4 Levels, ramps, bridges, tunnels | 2, 3, 11 |
| 5.5 Trains, dead ends | 5, 8, 14 |
| 5.5a Editing while running, lifting, undo | 10, 13 |
| 5.6 Switches (manual/auto, trailing, occupied) | 5, 8, 13, 14 |
| 5.7 Collisions | 9 |
| 5.8 Hill effect | 8 |
| 5.9 Styles, thumbnails, train colours, HiDPI | 11, 12, 13 |
| 5.10 Undo/redo | 6, 10, 13 |
| 5.11 Save/load, autosave | 4, 13 |
| 5.12 Screen layout | 13, 14 |

**Plan-level decisions not in the spec:**
- The exact geometry constants above.
- The diagonal straights (`straight-d1`, `straight-d1-2`) are added to the catalogue.
- `crossover-90` is √2 long.
- Tunnels are track-piece variants.
- The LEGO-style is labelled "Toy brick".
- `jsdom` is a dev dependency for the UI tests.
- The spec's "figure-eight over a bridge with ramps" closure test is split into a flat figure-eight (Task 2) and a raised oval with ramps (Task 2). Level separation at crossings is tested in Task 9.
