# Sketch Mode, Flex Pieces and Buffer Reversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three things to the existing track editor:
- flex pieces, with a gap-closing join solver;
- a sketch tool that turns a dragged line into real track, with a live ghost preview, switches, crossings, ramps and clicks;
- trains that pause for 2 s at buffer stops and then reverse.

**Architecture:**
- **Geometry.** Flex pieces carry their own geometry on the `Piece`. A new `pieceGeometry(piece)` accessor replaces the type-only catalogue lookups at every call site.
- **Sketch logic.** It lives in a new pure, testable `src/sketch/` layer:
  - `join.ts` (the join solver);
  - `splice.ts` (edits that switch, cross or split existing track);
  - `fitter.ts` (the live ghost, option 1: lay pieces one at a time);
  - `stroke.ts` (stroke start and release, building one undoable command).
- **UI.** `src/ui/sketchInput.ts` and `src/ui/sound.ts` wire it into the existing `Input`, `App`, toolbar and renderer.

**Tech Stack:** TypeScript (strict), Vite, Vitest (jsdom for UI tests), canvas 2D, Web Audio, and the pre-installed Playwright for the smoke script. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-sketch-mode-design.md`. It builds on `docs/superpowers/specs/2026-11-24-track-layout-design.md`.

## Global Constraints

- **Dependencies.** No runtime dependencies (`dependencies` stays empty). Sound is synthesised with Web Audio, with no audio files.
- **Units.** As in v1: positions in U, angles in degrees measured from +x toward +y with y pointing down, and positive sweep turns right.
- **Existing geometry.** The v1 catalogue piece geometry is unchanged. The new types are `flex-straight` and `flex-curve`, in a new palette family `flex` labelled **"Flex"**.
- **Flex limits.** These are exact:
  - flex straight: `0.05 ≤ length ≤ 4`;
  - flex curve: `R_S ≤ radius ≤ 8` and `0 < sweep ≤ 45`.

  Sweep is stored positive; direction comes from `flipped`, as for other curves.
- **Flex defaults** in the palette: straight `length 1`; curve `radius R_M`, `sweep 22.5`.
- **Save format.** It is now `VERSION = 2`:
  - version 1 files still load (they simply have no flex pieces);
  - a `flex` field is required on flex pieces and forbidden on all others.
- **Undo.** A sketch stroke is committed as **one** undo step. Any edit that removes or moves existing pieces goes through `withLifting`.
- **Joins.** Joins must land within v1 `JOIN_POS_TOL = 0.01` and `JOIN_ANGLE_TOL = 1`.
- **Strokes.** A stroke shorter than **0.5U** total is ignored. **Esc** during a drag cancels that stroke. **S** or the toolbar **Sketch** button enters sketch mode.
- **Levels.** `+` / `−` (also `=` / `_`) during a drag request a ramp. Out of the range 0..`MAX_LEVEL` they are ignored and play a "bonk".
- **Buffer stops.** A running train at the end of a `buffer` route waits **2 s of simulation time**, then reverses and carries on. A bare open end still brings a train to a stop.
- **Sound.**
  - At most one click per **40 ms**.
  - On by default, with a toolbar **Sound** toggle.
  - The preference is stored in `localStorage` key `track-layout:sound` (`'on'` or `'off'`), with try/catch around every access.
- **Switches and crossings.** They are only made on **plain straight** track: types `straight-*` and `flex-straight`. Never on bridges, tunnels, curves, ramps, switches or crossings.

## Review Focus

1. **A stroke that loops back over its own earlier ghost on the same level.** A crossing piece should be inserted, exactly as for existing track; the stroke must not silently overlap itself. Test in Task 8.
2. **A very fast pointer**, with a single move event 10U away from the last. The ghost must append several pieces in one call, leaving no gaps and following the line. Test in Task 8.
3. **A stroke that starts or ends on a straight a running train is on.** The piece is replaced by a switch splice; the train must be lifted (not left pointing at a deleted piece), and undo must restore both. Test in Task 9.
4. **Pressing `+` at `MAX_LEVEL`, or `−` at level 0.** It is ignored, with no ramp and no level change, and reports "out of range". Test in Task 8.
5. **A hand-edited v2 file** with a flex curve of radius 0.3, a flex field on a plain straight, or a flex piece with no flex field. It is rejected with a clear error. A v1 file still loads. Test in Task 1.

---

## File structure

```
src/track/catalog.ts         + flex types, FlexParams, FLEX_LIMITS, pieceGeometry(), validFlex()
src/model/types.ts           + Piece.flex
src/io/serialize.ts          VERSION 2, flex read/write/validate, v1 migration
src/sim/simulation.ts        + buffer-stop wait-and-reverse
src/sketch/spec.ts           PieceSpec, specToPiece(), chainEnd() helpers shared by sketch modules
src/sketch/join.ts           solveJoin() (exact straights / biarc with flex curves)
src/sketch/gap.ts            closeGap() command for near-miss clicks
src/sketch/flexResize.ts     flexResize() pure helper + resizeFlex() command
src/sketch/splice.ts         switchSplice(), crossingSplice(), mergeStraights()
src/sketch/fitter.ts         StrokeFitter (live ghost)
src/sketch/stroke.ts         beginStroke(), finishStroke()
src/ui/sound.ts              Clicker
src/ui/sketchInput.ts        SketchController (pointer/keys in sketch mode)
src/ui/input.ts, app.ts, toolbar.ts, palette.ts, render/renderer.ts, render/styles/*.ts   wiring
tests/... mirrors src
```

---

### Task 1: Flex geometry, model and save format

**Files:**
- Modify: `src/track/catalog.ts`, `src/model/types.ts`, `src/io/serialize.ts`. Also migrate every call site that holds a `Piece` and uses `pieceConnectors`, `pieceRoutes` or `pieceFootprint`: `src/track/graph.ts`, `src/sim/motion.ts`, `src/sim/simulation.ts`, `src/editor/commands.ts`, `src/editor/snapping.ts`, `src/ui/input.ts`, `src/ui/app.ts`, `src/render/renderer.ts`, `src/render/styles/*.ts`.
- Test: `tests/track/flex.test.ts`, `tests/io/serialize.test.ts`.

**Interfaces:**
- Produces, from `catalog.ts`:
  - `type FlexParams = { length: number } | { radius: number; sweep: number }`
  - `FLEX_LIMITS = { minLength: 0.05, maxLength: 4, minRadius: R_S, maxRadius: 8, maxSweep: 45 }`
  - `Family` gains `'flex'`; `PieceDef` gains `flex?: 'straight' | 'curve'`; catalogue entries `flex-straight` (label "Flex straight") and `flex-curve` (label "Flex curve"); `flex-curve` is flippable.
  - `FLEX_DEFAULTS: Record<'flex-straight' | 'flex-curve', FlexParams>`, holding `{ length: 1 }` and `{ radius: R_M, sweep: 22.5 }`.
  - `validFlex(type: string, flex: FlexParams | undefined): boolean`, which is true only for the matching shape within `FLEX_LIMITS`.
  - `interface PieceGeometry { connectors: ConnectorDef[]; routes: RouteDef[]; footprint: Vec2[][] }`
  - `pieceGeometry(p: Pick<Piece, 'type' | 'flipped' | 'flex'>): PieceGeometry`. It is cached by `type|flipped|params`. For flex types it builds the route with `makePath`: `{line: length}`, or `{arc: {radius, sweep}}` mirrored when flipped. It uses the same connector and footprint construction as catalogue pieces. A flex type without `flex` uses `FLEX_DEFAULTS`.
  - The existing `pieceConnectors`, `pieceRoutes` and `pieceFootprint(type, flipped)` stay, for the palette and tests. After this task **no `src/` call site that has a `Piece` uses them**.
- Produces, from `types.ts`: `Piece.flex?: FlexParams`.
- Produces, from `serialize.ts`: `VERSION = 2`. A piece is written with a `flex` field when present (numbers rounded to 6 decimals).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/track/flex.test.ts
test('flex straight of 1.3 has connectors 1.3 apart, opposite headings', () => {
  const g = pieceGeometry({ type: 'flex-straight', flipped: false, flex: { length: 1.3 } });
  expect(dist(g.connectors[0].pos, g.connectors[1].pos)).toBeCloseTo(1.3);
  expect(angleDiff(g.connectors[0].heading, g.connectors[1].heading + 180)).toBeLessThan(1e-9);
});
test('flex curve R_M/45 equals curve-m-45 geometry; flipped turns left', () => {
  const f = pieceGeometry({ type: 'flex-curve', flipped: false, flex: { radius: R_M, sweep: 45 } });
  const c = pieceGeometry({ type: 'curve-m-45', flipped: false });
  expect(f.connectors[1].pos.x).toBeCloseTo(c.connectors[1].pos.x); expect(f.connectors[1].pos.y).toBeCloseTo(c.connectors[1].pos.y);
  expect(pieceGeometry({ type: 'flex-curve', flipped: true, flex: { radius: R_M, sweep: 45 } }).connectors[1].pos.y).toBeLessThan(0);
});
test('validFlex enforces limits and shape', () => {
  expect(validFlex('flex-straight', { length: 0.05 })).toBe(true);
  expect(validFlex('flex-straight', { length: 0.04 })).toBe(false);
  expect(validFlex('flex-curve', { radius: 0.3, sweep: 10 })).toBe(false);
  expect(validFlex('flex-curve', { radius: 2, sweep: 46 })).toBe(false);
  expect(validFlex('flex-curve', { length: 1 } as FlexParams)).toBe(false);
});
test('two flex straights end to end join in the graph', () => { /* buildGraph → joins.size 2 */ });
test('a train runs across a flex curve', () => { /* advance through flex-curve; poseAt heading changes by sweep */ });
// tests/io/serialize.test.ts (additions)
test('v2 round trip keeps flex params', () => { /* … */ });
test('v1 file still loads', () => { /* version 1, no flex → ok */ });
test.each([
  ['flex curve radius 0.3', /flex/], ['flex field on straight-1', /flex/], ['flex-straight without flex', /flex/],
])('rejects bad flex: %s', (_, msg) => { /* fixtures → ok false, error matches */ });
```

- [ ] **Step 2: Run `npx vitest run tests/track/flex.test.ts tests/io`.** Expected: FAIL.
- [ ] **Step 3: Implement** the flex geometry, `Piece.flex`, serialize v2, and the call-site migration to `pieceGeometry`.
- [ ] **Step 4: Run `npm test && npm run build`.** Expected: all pass. The existing tests are unchanged apart from the version-number expectations.
- [ ] **Step 5: Commit** with `feat: flex pieces in the model, geometry and save format (v2)`.

---

### Task 2: Flex pieces in styles and palette

**Files:**
- Modify: `src/render/styles/wooden.ts`, `model.ts`, `brick.ts` (only where they special-case types), `src/ui/palette.ts`, `src/ui/input.ts` (placing a flex type sets `flex` from `FLEX_DEFAULTS`).
- Test: `tests/render/renderer.test.ts`, `tests/ui/input.test.ts`.

**Interfaces:**
- Consumes: `pieceGeometry`, `FLEX_DEFAULTS` (Task 1).
- Produces:
  - Palette group **"Flex"** with two tiles.
  - A flex piece placed from the palette carries `flex = FLEX_DEFAULTS[type]`.
  - The wooden style draws a darker joint line across the band at both ends of a flex piece. Model and brick draw flex like their straight and curve.

- [ ] **Step 1: Write the failing tests.** Two in `tests/render/renderer.test.ts`:
  - `render` with `flex-straight` and `flex-curve`, both flips, in all 3 styles, doesn't throw;
  - in the wooden style, a flex piece issues at least 2 more `stroke` calls than the same-shaped catalogue piece.

  One in `tests/ui/input.test.ts`: placing "Flex curve" from the palette gives a piece with `flex: { radius: R_M, sweep: 22.5 }`.
- [ ] **Step 2: Run `npx vitest run tests/render tests/ui`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: draw and place flex pieces`.

---

### Task 3: Buffer-stop wait-and-reverse

**Files:**
- Modify: `src/sim/simulation.ts`.
- Test: `tests/sim/simulation.test.ts`, updating the v1 tests that expect a permanent stop *at a buffer*. Open-end tests stay as they are.

**Interfaces:**
- Produces: `BUFFER_WAIT = 2` (seconds). Inside `Simulation`, per-train wait timers are pruned like the other per-train state.
- **Rule:** after a substep, a train counts as "resting at a buffer" when all of these hold:
  - it is not lifted;
  - it is `running` and not `crashed`;
  - `currentSpeed === 0`;
  - `head` is on a piece of type `buffer` with `distanceAhead(head, 0.01) <= 0.005`.

  Its timer then adds `h` each substep. When the timer reaches `BUFFER_WAIT`, call `this.reverse(id)`, keep `running = true` and clear the timer. A train not resting has its timer cleared.

- [ ] **Step 1: Write the failing tests**

```ts
test('train at a buffer waits 2 s then reverses and runs away', () => {
  /* straight-2 → buffer; train running toward buffer; step until currentSpeed 0 at end;
     step 1.9 s → head unchanged; step 0.2 s more → head dir flipped; step 2 s → moved away, running true */
});
test('pause does not advance the buffer wait', () => { /* sim.paused = true; step(5); unpause; still waiting */ });
test('stopping the train during the wait cancels the reversal', () => { /* running=false at 1 s; step 3 s → not reversed */ });
test('a bare open end still stops for good', () => { /* straight with no buffer: after 5 s still at end, not reversed */ });
test('pressing Run at a buffer starts a fresh 2 s wait', () => { /* … */ });
```

- [ ] **Step 2: Run `npx vitest run tests/sim/simulation.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: trains pause 2 s at buffer stops and reverse`.

---

### Task 4: Shared piece-spec helpers and the join solver

**Files:**
- Create: `src/sketch/spec.ts`, `src/sketch/join.ts`.
- Test: `tests/sketch/join.test.ts`.

**Interfaces:**
- Produces, from `spec.ts`:
  - `type PieceSpec = Omit<Piece, 'id'>`
  - `specToPiece(spec: PieceSpec, id: string): Piece`
  - `outPose(spec: PieceSpec, connector: number): Pose`. This is the world pose of that connector, with `rot` = its outward heading.
  - `attachSpec(type: string, flipped: boolean, flex: FlexParams | undefined, at: Pose, level: number, enter = 0): PieceSpec`. It places a piece so that its connector `enter` mates with the outward pose `at`, and its rot comes out as `at.rot + 180 − conn.heading`.
  - `chainEnd(specs: PieceSpec[], exit = 1): Pose`, the outward pose of the last spec's `exit` connector.
- Produces, from `join.ts`:
  - `solveJoin(from: Pose, to: Pose, level: number): PieceSpec[] | null`
    - `from` is the outward pose where the new chain starts. `to` is the outward pose of the target connector.
    - The result is a chain whose first piece enters at `from` and whose last exit mates with `to`: same position, opposite heading, within the join tolerances.
    - It returns `null` when no chain within `FLEX_LIMITS` exists.
  - `JOIN_MAX_PIECES = 8`.

**Algorithm (in order; the builder picks the biarc parameterisation):**
1. **Straight ahead.** If `to` lies straight ahead (lateral offset < `JOIN_POS_TOL` and heading opposite within `JOIN_ANGLE_TOL`), fill with catalogue straights (2, 1, ½, ¼, largest first). Put any remainder of 0.05 or more into a flex straight. If the remainder is non-zero but below 0.05, fold it into the last straight to make a flex straight.
2. **Otherwise, a biarc.** Use two tangent-continuous arcs. Arcs with `radius > 8` and sweep < 0.5° become flex straights. Each arc must have `radius ≥ R_S`. An arc with sweep > 45° is split into `ceil(sweep/45)` equal flex curves. Try equal-length tangent parameters first, then a short search over the ratio, up to 9 values, and keep the first valid result.
3. **No solution.** If no candidate fits within `JOIN_MAX_PIECES` pieces, return `null`.

- [ ] **Step 1: Write the failing tests**

```ts
const closesOn = (chain: PieceSpec[], to: Pose) => {
  const e = chainEnd(chain);
  expect(dist(e, to)).toBeLessThan(JOIN_POS_TOL); expect(angleDiff(e.rot, to.rot + 180)).toBeLessThan(JOIN_ANGLE_TOL);
  for (const s of chain) if (s.flex) expect(validFlex(s.type, s.flex)).toBe(true);
};
test('1.3 straight ahead → straight-1 + flex 0.3', () => {
  const c = solveJoin({ x: 0, y: 0, rot: 0 }, { x: 1.3, y: 0, rot: 180 }, 0)!;
  expect(c.map((s) => s.type)).toEqual(['straight-1', 'flex-straight']); closesOn(c, { x: 1.3, y: 0, rot: 180 });
});
test('2U ahead, D sideways, same heading → S-bend that closes', () => {
  const to = { x: 2, y: D, rot: 180 }; closesOn(solveJoin({ x: 0, y: 0, rot: 0 }, to, 0)!, to);
});
test('U-turn radius 1 → several flex curves each ≤ 45°', () => {
  const to = { x: 0, y: 2, rot: 0 }; const c = solveJoin({ x: 0, y: 0, rot: 0 }, to, 0)!;
  expect(c.length).toBeGreaterThanOrEqual(4); closesOn(c, to);
});
test('0.02 sideways with 0.1 forward is impossible → null', () => {
  expect(solveJoin({ x: 0, y: 0, rot: 0 }, { x: 0.1, y: 0.02, rot: 180 }, 0)).toBeNull();
});
test('random feasible targets always close exactly when solved', () => { /* 200 seeded random poses 2–6U away; every non-null result passes closesOn */ });
```

- [ ] **Step 2: Run `npx vitest run tests/sketch/join.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** `spec.ts` and `join.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: join solver with exact straights and flex biarcs`.

---

### Task 5: Close a near miss by clicking it

**Files:**
- Create: `src/sketch/gap.ts`.
- Modify: `src/ui/input.ts` (in select mode, a click within the snap radius of a near-miss midpoint calls `closeGap`), `src/render/renderer.ts` (`Overlay.flashRing?: Vec2`, drawn red for 400 ms).
- Test: `tests/sketch/gap.test.ts`, `tests/ui/input.test.ts`.

**Interfaces:**
- Consumes: `solveJoin`, `specToPiece`, `outPose` (Task 4); `withLifting`, `batch`, `placePieces`, `deletePieces`.
- Produces:
  - `PLAIN_TYPES` (the predicate `isPlainTrack(type)`): true for `straight-*`, `curve-*`, `flex-straight` and `flex-curve`.
  - `closeGap(doc: Doc, a: WorldConnector, b: WorldConnector): Command | null`.
    1. First try `solveJoin(outPose(a), outPose(b))`.
    2. If that fails, consume up to **two** plain pieces backwards from `a`, then from `b`, then from both. That is up to 8 combinations, smallest first. A piece can only be consumed if it is plain and lies in a simple chain (its other connector is joined, or it has exactly 2 connectors). Re-solve between the new outer poses.
    3. The result is `withLifting(doc, consumedIds, batch('Close gap', [deletePieces(consumed), placePieces(newPieces)]))`.
    4. It returns `null` if nothing fits. It never consumes switches, crossings, ramps, bridges, tunnels or buffers.

- [ ] **Step 1: Write the failing tests:**
  - **Wide gap:** a 0.2U gap on a straight line closes with one flex straight, and `graph.nearMisses` becomes empty.
  - **Tiny offset:** a near miss with 0.03 sideways offset and 1° of angle closes by consuming neighbours. The result has no open connectors where the gap was, all flex pieces pass `validFlex`, and undo restores the original pieces exactly.
  - **Protected neighbours:** a gap whose only neighbours are switches returns `null`.
  - **Trains:** a train on a consumed piece is lifted.
  - **UI:** in `tests/ui/input.test.ts`, clicking on the ring closes the gap as one history entry.
- [ ] **Step 2: Run `npx vitest run tests/sketch/gap.test.ts tests/ui`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: click a near-miss ring to close it with flex pieces`.

---

### Task 6: Flex resize handles

**Files:**
- Create: `src/sketch/flexResize.ts`.
- Modify: `src/ui/input.ts` (drag handles on the open ends of a selected flex piece), `src/render/renderer.ts` (draw the handles: small squares at the open connectors of selected flex pieces).
- Test: `tests/sketch/flexResize.test.ts`, `tests/ui/input.test.ts`.

**Interfaces:**
- Produces:
  - `flexResize(piece: Piece, end: 0 | 1, to: Vec2, alt: boolean): { flex: FlexParams; x: number; y: number; rot: number }`. The other end stays fixed.
    - **Straight:** the new length is the projection of `to` onto the piece axis.
    - **Curve:** the sweep follows the angle swept to `to`. With `alt`, the radius changes instead.
    - **Limits:** values are clamped to `FLEX_LIMITS`.
  - `resizeFlex(id: string, next: { flex: FlexParams; x: number; y: number; rot: number }): Command`. It snapshots and restores `flex` and the pose, and is always issued via `withLifting(doc, [id], …)`.

- [ ] **Step 1: Write the failing tests:**
  - dragging end 1 of a flex straight of length 1 to (2.5, 0.3) gives length 2.5, with end 0 unchanged;
  - dragging end 0 keeps end 1's world pose fixed;
  - curve sweep is clamped at 45;
  - with Alt, the radius changes and the sweep is kept;
  - the result is clamped at the minimum length 0.05;
  - in the UI test, a handle drag is one history entry and is undoable.
- [ ] **Step 2: Run `npx vitest run tests/sketch/flexResize.test.ts tests/ui`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: resize flex pieces by dragging their ends`.

---

### Task 7: Splices: switches, crossings, merging straights

**Files:**
- Create: `src/sketch/splice.ts`.
- Test: `tests/sketch/splice.test.ts`.

**Interfaces:**
- Consumes: Task 4 helpers, `pieceGeometry`, `worldRoutePath`, `buildGraph`/joins.
- Produces:
  - `interface Splice { remove: string[]; add: PieceSpec[] }`
  - `isPlainStraight(type: string): boolean`, true for `straight-*` and `flex-straight`.
  - `switchSplice(doc: Doc, pt: Vec2, level: number, strokeDir: Vec2, mode: 'diverge' | 'merge', snapRadius: number): { splice: Splice; branch: Pose } | null`.
    - **Placement:** it finds the nearest point within `snapRadius` on a plain-straight route at `level`. It centres a 1U `switch` there, shifted along the run if needed so the 1U fits inside the run of joined plain straights. It refills the rest of the run with catalogue straights plus flex.
    - **Branch side:** `flipped` is set so the branch turns toward `strokeDir`.
    - **Orientation:** for `'diverge'`, the switch entry faces against the stroke's along-track direction. For `'merge'` it is mirrored, so the branch receives the incoming stroke.
    - **`branch`:** the outward pose of the switch's branch connector.
    - **Returns `null`** if no plain straight is within `snapRadius`.
  - `crossingSplice(doc: Doc, pieceId: string, at: Vec2, strokeHeading: number): { splice: Splice; entry: Pose; exit: Pose; type: 'crossover-90' | 'crossover-45' } | null`.
    - It uses `crossover-90` if the angle between the stroke and the track (taken modulo 180) is within 67.5° of perpendicular, otherwise `crossover-45`.
    - The crossover is centred on `at`, with one route along the existing track. The rest of the existing plain straight run is refilled.
    - `entry` is the outward pose of the crossover connector that the stroke arrives at, and `exit` is the opposite one, on the other route.
    - It returns `null` when the piece isn't a plain straight.
  - `mergeStraights(specs: PieceSpec[]): PieceSpec[]`. It merges consecutive collinear straights (catalogue or flex) on the same level into the fewest catalogue straights (2, 1, ½, ¼) plus at most one flex remainder of 0.05 or more. Other specs are left unchanged.

- [ ] **Step 1: Write the failing tests:**
  - **Diverging switch:** on a straight-2, at 0.7 along, with the stroke heading up and right, the splice removes the straight-2 and adds a switch plus straight(s) (and flex if needed). The new pieces fully join with the old neighbours: build a graph after applying the splice and expect no new open connectors besides the branch. The branch pose heading is 45° off the track, toward the stroke.
  - **Merging switch:** the `'merge'` splice gives a branch whose outward heading faces the incoming stroke.
  - **Refused on non-plain track:** `switchSplice` on a curve, bridge or tunnel with no plain straight within the radius returns `null`.
  - **Crossings:** a stroke crossing a straight-2 at 80° gives `crossover-90`, and at 40° gives `crossover-45`. Entry and exit are on opposite sides. After the splice the old track is still continuous through the crossover's other route.
  - **Merging straights:** `[s1, s1, s½, flex 0.3]` collinear merges to `[straight-2, straight-1-2, flex 0.3]`; a curve between straights breaks a run.
- [ ] **Step 2: Run `npx vitest run tests/sketch/splice.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: switch and crossing splices, straight merging`.

---

### Task 8: StrokeFitter: the live ghost

**Files:**
- Create: `src/sketch/fitter.ts`.
- Test: `tests/sketch/fitter.test.ts`.

**Interfaces:**
- Consumes: Tasks 4 and 7, and the `Doc`/graph routes for crossing detection.
- Produces:
  - Constants: `STEP_DIST = 0.75`, `LOOKAHEAD = 1.0`, `START_DIST = 0.5`. The scoring weights are the builder's choice, recorded as named constants.
  - `FREEHAND_SET`: `straight-1-4`, `straight-1-2`, `straight-1`, then `curve-l-22`, `curve-s-45`, `curve-m-45`, `curve-l-45`, each unflipped and flipped.
  - `SHIFT_SET`: `straight-1`, plus `curve-m-45` and `curve-l-45` unflipped and flipped. If the heading is not a multiple of 45, a single `curve-l-22` either way is also allowed.
  - `interface FitterStart { pos: Vec2; heading: number | null; level: number }`
  - The `StrokeFitter` class:
    - `constructor(doc: Doc, start: FitterStart)`.
    - `addPoint(p: Vec2, shift: boolean): number`. It returns the number of pieces appended, which the caller turns into clicks.
    - `requestRamp(dir: 1 | -1): boolean`. It returns false, and changes nothing, if the level after any pending ramp would leave 0..`MAX_LEVEL`.
    - Read-only fields:
      - `points: Vec2[]`;
      - `pieces: PieceSpec[]`;
      - `lead: { pose: Pose; level: number }`;
      - `pendingRamp: -1 | 0 | 1`;
      - `crossings: Array<{ index: number; splice: Splice }>` (the ghost-piece index the crossover sits at);
      - `redFrom: number | null` (the index of the first point drawn red);
      - `length: number` (the total stroke length).

**Behaviour** (spec §5.3, §5.5, §5.8):
- **Heading.** A `null` heading is fixed once the stroke has moved `START_DIST` away: it is the drag direction, rounded to 22.5° (45° with `shift`).
- **Appending pieces.** While the newest point is more than `STEP_DIST` past the lead, measured along the stroke, the fitter scores each candidate against the stroke point `LOOKAHEAD` ahead and appends the best one. It loops, so one far-away point appends several pieces.
- **Ramps.** While a ramp is pending, only straights are candidates. Once the stroke has 2U of straight run available, `ramp-2` is appended (entered at connector 0 for `+`, or connector 1 for `−`), and the level changes.
- **Crossings.**
  - **When it applies.** A candidate whose route comes within `OVERLAP_CLEARANCE` of a same-level route crosses it. That route may belong to an existing piece or to an earlier ghost piece other than the last one.
  - **Plain straight crossed:** the fitter builds the `crossingSplice`. For ghost track, it uses an equivalent internal splice of its own ghost pieces. It then replaces up to the last two ghost pieces with `solveJoin(lead, entry)`, records the crossing and continues from `exit`.
  - **Not plain straight:** `redFrom` is set, and no more pieces are appended.
- **Ghost pieces are never revised,** except by the crossing re-join above.

- [ ] **Step 1: Write the failing tests:**
  - **Straight line:** a straight drag of 5U east gives about 5U of straight pieces along heading 0, with the lead within 0.75 of the pointer.
  - **Circle:** a quarter-circle drag of radius 2.2 (sampled every 0.1) ends with the heading within 22.5° of 90, and every piece is from `FREEHAND_SET`.
  - **Shift:** a Shift drag east then north gives only `SHIFT_SET` pieces, and every lead heading is a multiple of 45.
  - **Shift after a 22.5° bend:** starting at heading 22.5 with Shift gives a single `curve-l-22` first, then 45° multiples.
  - **Fast pointer (Review Focus 2):** `addPoint` once at 10U returns 8 or more, and the pieces chain without gaps (each next spec's connector 0 mates with the previous `outPose(…, 1)`).
  - **Ramps:** `requestRamp(1)` then a 4U drag gives a `ramp-2`, and the lead level is 1. `requestRamp(1)` at level `MAX_LEVEL` returns false and changes nothing; so does `requestRamp(-1)` at level 0 (Review Focus 4).
  - **Crossing existing track:** a drag across an existing same-level straight-2 records one crossing of the expected type, and the ghost continues past it.
  - **Crossing a bridge:** a drag across a level-0 straight while the stroke is at level 1 records no crossing.
  - **Crossing a curve:** a drag across an existing curve sets `redFrom` and stops appending.
  - **Crossing itself (Review Focus 1):** a loop-shaped drag that crosses its own earlier ghost records a crossing.
- [ ] **Step 2: Run `npx vitest run tests/sketch/fitter.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Tune the weights until the tests pass and the quarter circle looks smooth.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: live stroke fitter for sketch mode`.

---

### Task 9: Stroke start and release → one command

**Files:**
- Create: `src/sketch/stroke.ts`.
- Test: `tests/sketch/stroke.test.ts`.

**Interfaces:**
- Consumes: Tasks 4, 7 and 8; `withLifting`, `batch`, `placePieces`, `deletePieces`.
- Produces:
  - `type StrokeStart = FitterStart & { startSplice?: Splice; removeBuffer?: string; attachedTo?: WorldConnector; empty: boolean }`
  - `beginStroke(doc: Doc, pt: Vec2, level: number, snapRadius: number, strokeDir?: Vec2): StrokeStart | 'refused'`. It is tried in this order:
    1. **Open connector within the radius:** continue from it.
    2. **Buffer piece hit, or its connector within the radius:** continue from the buffer's connector, and set `removeBuffer`.
    3. **Point on a track route within the radius:** use `switchSplice('diverge')`. If that is `null`, return `'refused'`.
    4. **Otherwise:** an empty start at `level`.

    `strokeDir` is supplied once the drag direction is known, so the caller may call `beginStroke` again lazily for case 3.
  - `finishStroke(doc: Doc, start: StrokeStart, fitter: StrokeFitter, endPt: Vec2, snapRadius: number): Command | null`. It returns `null` when `fitter.length < 0.5`, or after a cancel. Steps (spec §5.4):
    1. Trim the last piece if the stroke went less than halfway past it.
    2. If `redFrom` is set, the stroke ends at the last good piece.
    3. Resolve the end:
       - **Open connector or buffer within the radius at the lead level:** `solveJoin`, consuming up to two trailing ghost pieces. Remove the buffer.
       - **Track route within the radius:** `switchSplice('merge')` plus `solveJoin` to its branch. If the switch is `null`, end with a buffer.
       - **Otherwise:** a buffer at the lead.
    4. If `start.empty`, add a buffer at the start, facing outward.
    5. Run `mergeStraights`.
    6. Swap raised straights that pass over lower track for `bridge-1` / `bridge-2`.
    7. Build one `withLifting(doc, allRemovedIds, batch('Sketch', [...]))` command that covers the splices (start, crossings, end), removed buffers and new pieces.

- [ ] **Step 1: Write the failing tests:**
  - **From empty table:** the stroke commits with buffers at both ends and no open connectors. One `history.exec` adds them; one undo removes them all.
  - **From an open end:** the stroke continues it, with no buffer at the start.
  - **From a buffer stop:** the buffer is removed and the new track mates with the old connector.
  - **Ending near an open connector 0.3U off-line:** it joins exactly (no open connectors there), with flex used if needed.
  - **Ending on the middle of a straight:** a merging switch is created, fully joined.
  - **Starting on a curve with no straight nearby:** `beginStroke` returns `'refused'`.
  - **Ending on a curve with no straight nearby:** it ends in a buffer, and the rest of the stroke is kept.
  - **Short stroke:** a 0.3U stroke returns `null`.
  - **Running train (Review Focus 3):** a stroke starting on a straight that a running train occupies lifts the train. `sim.step` doesn't throw, and undo restores the straight and the train.
  - **Raised straight:** a raised straight over level-0 track becomes a bridge piece.
- [ ] **Step 2: Run `npx vitest run tests/sketch/stroke.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: commit a sketch stroke as one undoable command`.

---

### Task 10: Click sound

**Files:**
- Create: `src/ui/sound.ts`.
- Test: `tests/ui/sound.test.ts` (with a fake `AudioContext` injected).

**Interfaces:**
- Produces:
  - `SOUND_PREF_KEY = 'track-layout:sound'`, `MIN_CLICK_MS = 40`.
  - The `Clicker` class:
    - `constructor(opts?: { ctxFactory?: () => AudioContext | null; now?: () => number; storage?: Storage | null })`;
    - `enabled: boolean`, loaded from storage with default true, and saved on `setEnabled(on)`;
    - `unlock(): void`, which creates or resumes the context on the first user gesture;
    - `tick(): void` and `settle(): void`, rate-limited by `MIN_CLICK_MS`;
    - `bonk(): void`.

    Every sound is a no-op when disabled, or when there is no context.
- **Sound design:** a tick is a sine or filtered-noise blip of about 15 ms at gain 0.06 or less (−24 dBFS), with ±8% random pitch. The settle tick is lower. The bonk is about 80 ms at roughly 120 Hz.

- [ ] **Step 1: Write the failing tests:**
  - **Rate limit:** 5 ticks within 30 ms start 1 oscillator or source, and ticks 50 ms apart start 2.
  - **Mute:** `setEnabled(false)` stores `'off'`, and `tick` starts none.
  - **Throwing storage:** a throwing storage doesn't throw and leaves the default on.
  - **No audio:** with no `AudioContext` everything is a no-op.
- [ ] **Step 2: Run `npx vitest run tests/ui/sound.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: generated click sounds with mute preference`.

---

### Task 11: Sketch mode UI and drawing

**Files:**
- Create: `src/ui/sketchInput.ts`.
- Modify:
  - `src/ui/input.ts`: `Mode` gains `{ kind: 'sketch' }`; the `S` key; delegating pointer and keys to `SketchController` in sketch mode; Esc behaviour.
  - `src/ui/app.ts`: owns the `Clicker` and calls `unlock()` on the first pointer-down.
  - `src/ui/toolbar.ts`: a **Sketch** toggle button and a **Sound** toggle.
  - `src/render/renderer.ts`: `Overlay.sketch`.
  - `index.html`: the pen and not-allowed cursors.
- Test: `tests/ui/sketch.test.ts` (jsdom).

**Interfaces:**
- Consumes: Tasks 8, 9 and 10.
- Produces:
  - The `SketchController` class:
    - `constructor(app: App)`;
    - `down(world: Vec2): void`, `move(world: Vec2, shift: boolean): void`, `up(world: Vec2): void`;
    - `key(e: KeyboardEvent): boolean`, which returns true when handled (`+`, `=`, `-`, `_`, Escape);
    - `cancel(): void`;
    - `overlay(): Overlay['sketch']`.
  - `Overlay.sketch?: { points: Vec2[]; ghost: Piece[]; level: number; redFrom: number | null; pendingRamp: -1 | 0 | 1; refusedAt?: Vec2; switchPreview?: Piece[] }`.
  - **Renderer drawing order:**
    - the stroke as a 2px translucent line, red from `redFrom`;
    - the ghost pieces at 50% alpha, in the current style;
    - a lead dot with an ↑ or ↓ badge when `pendingRamp ≠ 0`;
    - the switch preview outline;
    - a red ✕ at `refusedAt`.
- **Behaviour:**
  - Each piece appended plays `tick()`, and a committed stroke plays `settle()`.
  - A refused `+`/`−` plays `bonk()`.
  - A refused start shows the not-allowed cursor, and no drag begins.
  - `up` runs `app.exec(cmd)` when `finishStroke` returns a command.
  - Pan with the middle button or Space+drag, and wheel zoom, still work in sketch mode.

- [ ] **Step 1: Write the failing tests:**
  - **Entering:** `S` enters sketch mode and Esc leaves it.
  - **Basic stroke:** a pointer drag of 4U east from empty table commits once (history +1), adding pieces with buffers at both ends.
  - **Clicks:** the fake clicker counts one tick per appended piece and one settle.
  - **Cancel:** Esc mid-drag commits nothing.
  - **Ramp:** pressing `+` mid-drag gives a ramp, and later pieces are at level 1.
  - **Shift:** Shift held gives only 45° headings.
  - **Refused start:** a drag starting on a curve (with no straight nearby) commits nothing and sets `refusedAt`.
  - **Typing:** keys typed into a text input don't trigger sketch keys.
- [ ] **Step 2: Run `npx vitest run tests/ui/sketch.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run build`.** Expected: PASS.
- [ ] **Step 5: Manual check.** In `npm run dev`, use Playwright with mouse moves to draw:
  - a freehand S-curve;
  - a Shift L-shape;
  - a stroke from the middle of a straight (a switch should appear);
  - a stroke across a straight (a crossing should appear);
  - a stroke with `+`.

  Take screenshots to `scripts/out/sketch-*.png` and look at them.
- [ ] **Step 6: Commit** with `feat: sketch mode tool with live ghost, ramps, switches and crossings`.

---

### Task 12: End-to-end smoke for sketch and flex

**Files:**
- Modify: `scripts/smoke.mjs`.

**Interfaces:**
- Consumes: everything above, via `window.__app` and real mouse and keyboard events.

- [ ] **Step 1: Extend `scripts/smoke.mjs`.** Add these checks after the existing ones:
  1. Reset the layout to empty via `window.__app`.
  2. Press `S` to enter sketch mode. Hold Shift and drag 6U east, then 4U north, with 30 mouse moves.
  3. Check there are more than 3 pieces, 2 buffer pieces and `graph.open.length === 0`.
  4. Undo once and check there are 0 pieces.
  5. Redo. Place a train on the track, run it and wait 8 s. Check it has reversed at least once: its `head.dir` or piece changed back.
  6. Save the layout via `serialize`, then `deserialize` it, and check `ok`.

  Keep the existing console-error gate.
- [ ] **Step 2: Run `npm run smoke`.** Expected: `smoke: all checks passed`.
- [ ] **Step 3: Commit** with `test: smoke covers sketch strokes, buffers and reversal`.

---

## Spec coverage map

| Spec § | Task(s) |
|---|---|
| 5.1 Flex pieces (model, geometry, limits, palette, styles, save v2, resize, near-miss close) | 1, 2, 5, 6 |
| 5.2 Entering and leaving sketch mode | 11 |
| 5.3 Stroke and live ghost (freehand and Shift sets, step, lookahead, fast pointer) | 8, 11 |
| 5.4 Release tidy-up and commit (trim, end resolution, buffers, merging, one command, short strokes) | 9 |
| 5.5 Levels `+`/`−`, ramps, bridge pieces for raised straights | 8, 9, 11 |
| 5.6 Join solver | 4 (used by 5 and 9) |
| 5.7 Switches from the middle of track (diverge and merge, plain straight only, refuse or end-in-buffer) | 7, 9 |
| 5.8 Crossings (existing and own ghost, 90/45, red on curves) | 7, 8 |
| 5.9 Click sound (tick, settle, bonk, 40 ms, mute pref, unlock) | 10, 11 |
| 5.10 Buffer-stop reversal | 3 |
| 5.11 Rendering additions | 2, 6, 11 |
