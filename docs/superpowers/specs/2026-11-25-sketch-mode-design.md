# Sketch Mode, Flex Pieces and Buffer Reversal — Design

Date: 2026-11-25
Status: Draft, awaiting approval (builder check done)
Builds on: `docs/superpowers/specs/2026-11-24-track-layout-design.md` (v1, implemented)

## 1. Intent

Sketching becomes **the main way to design layouts**. You drag a line across the table, and the app lays real track along it as you draw. When you let go, it joins the new track up neatly with what is already there.

Placing pieces one at a time from the palette stays available. It becomes the precise tool you use afterwards.

The work comes as three parts that depend on each other:

1. **Flex pieces.** Adjustable straights and curves that close gaps exact pieces can't. Sketch mode needs them to join up, and you can also use them by hand to close "almost" gaps. They were deferred to v2 in the original design.
2. **Sketch mode** itself.
3. **Buffer-stop reversal.** A train that reaches a buffer stop pauses for 2 s, then reverses. This is because sketched lines now end in buffer stops by default.

## 2. Goals, non-goals, anti-goals

### Goals
- **Sketch tool.**
  - **Freehand drag.** Live ghost track follows the pointer, built from fixed-size pieces.
  - **Shift + drag.** Constrains the stroke to the 8 compass directions.
  - **Feedback.** A soft click sounds for each piece added.
  - **Releasing the drag.** The ends are tidied up and the stroke is committed as **one undo step**.
- **Levels.** Pressing `+` / `−` while dragging inserts a ramp up or down a level, which is how bridges get built.
- **Starting or ending on existing track.**
  - On the middle of existing track: that track becomes a **switch**.
  - On a loose end or a buffer stop: the stroke continues that track. A buffer stop is replaced by the right straight or curve.
- **Crossings.** A stroke that crosses same-level track is nudged so that a **crossing piece** (90° or 45°) fits there.
- **Default ends.** Ends of a stroke that attach to nothing get **buffer stops**.
- **Flex pieces.** A flex straight of any length and a flex curve of any radius and angle within limits. They are saved in layout files, appear in the palette, and fill near-miss gaps when you click the gap marker.
- **Buffer-stop reversal.** A running train that reaches a buffer stop waits 2 s, then reverses and carries on.

### Non-goals (this round)
- Re-sketching over existing track to re-route it, or erasing by sketch.
- Touch or pen input beyond what mouse events give for free.
- Automatic bridges over crossings. Crossings always get a crossing piece; to go over instead, press `+` before the crossing.
- Curved switches, or switches on curved track.
- Global or optimal fitting of the whole stroke (option 3 below).

### Anti-goals (failure even if it "works")
- **Jumpy ghost.** The preview reshuffles earlier pieces while you are still drawing.
- **Off-path track.** The result wanders noticeably off the drawn line on a smooth, deliberate stroke.
- **Broken commits.** A committed stroke leaves gaps, overlaps or a dangling stray piece where it should have joined.
- **Corrupted undo.** One stroke needs several undos, or undoing it corrupts trains or existing track.
- **Annoying sound.** The click is loud, or it cannot be turned off.

## 3. Constraints
- Same stack as v1: TypeScript, canvas 2D, vanilla DOM, and no runtime dependencies. Sound uses the Web Audio API with a generated click, not audio files.
- The v1 piece geometry is unchanged. Sketch mode uses the existing catalogue plus the two new flex types.
- **Save format.**
  - Adding flex pieces bumps the format to **version 2**.
  - v1 files still load, by a trivial migration: no flex pieces.
  - v2 files are rejected by the old app version, which is acceptable.
- Every edit, including a whole stroke, goes through the command and undo system, and through `withLifting` whenever existing pieces are removed or moved.

## 4. Approaches considered (for turning a line into pieces)

| Option | Summary | Trade-off |
|---|---|---|
| **1. Lay pieces one at a time following the pointer** *(chosen)* | The ghost has a leading end. When the stroke has moved far enough past it, the app tries each allowed piece and appends the one landing closest to the line about 1U ahead. Clicks once per piece. Shift limits the allowed set. Release does the join-up with flex pieces. | Simple and predictable. The ghost stays just behind the pointer, and one click is one piece. A shaky line can zig-zag slightly; a turn penalty limits that. |
| 2. Recognise straight runs and steady curves, then fill them | Segment the stroke into lines and constant-curvature arcs, then quantise each finished segment. | Smoother big curves. But the ghost lags further behind and more gets reworked at release. |
| 3. Search for the best-fitting sequence | Keep several candidate sequences and choose the best overall. | Most faithful. But earlier ghost pieces reshuffle mid-draw, which hits anti-goal 1, and it is the most complex. |

**Picked: option 1**, which the user chose. It can be upgraded towards option 2 later without changing the rest of the design.

**Fitting timing** (also the user's choice): a live ghost preview while dragging, then a tidy-up on release. The release step may rework the last one or two ghost pieces near the end of the stroke, so a small visible shift on release is acceptable.

## 5. Design

### 5.1 Flex pieces

There are two new catalogue types, each with per-instance geometry stored on the piece.

| type | parameters (`piece.flex`) | limits |
|---|---|---|
| `flex-straight` | `{ length }` | 0.05U ≤ length ≤ 4U |
| `flex-curve` | `{ radius, sweep }` (sweep in degrees; positive turns right, and `flipped` mirrors it as for other curves) | radius ≥ `R_S` (the small-curve radius, ≈0.586U) and ≤ 8U; 0 < sweep ≤ 45° |

**Behaviour like other pieces.** Both behave exactly like normal straights and curves:
- two connectors;
- one route;
- the same band footprint;
- joins, motion, collisions and rendering all work.

Each style draws them like its normal straight and curve. The wooden style adds a subtle mark, for example a darker joint line, so you can tell a flex piece from a standard one.

**Model.**
- `Piece` gains an optional `flex: { length } | { radius, sweep }`.
- Catalogue lookups that build connectors, routes or footprint for a piece must take the piece's `flex` parameters into account. Today they work from type and flipped only.
- **Builder's call:** how to restructure this, for example `pieceGeometry(piece)` replacing `pieceConnectors(type, flipped)` at call sites, with caching per parameter set.

**Palette.**
- The palette gets a **Flex** group with "Flex straight" (default 1U) and "Flex curve" (default R_M, 22.5°).
- When a flex piece is selected, dragging a handle on any of its **open** ends resizes it from that end, as an undoable `transformPieces`-style command (my call: this works on a loose piece too, not only an attached one):
  - a straight changes length;
  - a curve changes sweep, or radius with Alt held.
- **My call:** keep resize handles simple; no numeric entry panel in this round.

**Closing a near miss by hand.** Clicking a near-miss marker (the orange ring v1 already draws) closes the gap with flex pieces, as one undo step.
- **Why it may replace neighbouring pieces (my call).** Most near misses are tiny: a few hundredths of a U sideways or a degree or two of angle. A curve can't fit inside a gap that small. So the solver may **remove up to two neighbouring plain straights or curves on each side** and re-solve over the longer stretch, using the same join solver as sketch mode (§5.6).
- **What it never removes.** Switches, crossings, ramps, bridges, tunnels and buffers are never removed.
- **Trains.** The command goes through `withLifting`.
- **No solution.** If nothing fits, the ring flashes red and nothing changes.

**Saving.**
- The `flex` field is written for flex pieces and validated on load:
  - the parameters must exist and be within the limits above;
  - non-flex pieces must not carry a `flex` field.
- `VERSION = 2`. A v1 file migrates unchanged.

### 5.2 Entering and leaving sketch mode

- **Entering.** A **Sketch** button in the toolbar and the **S** key enter sketch mode. This is a new `Mode` kind, `'sketch'`.
- **The pointer.** It shows as a pen cursor.
- **Leaving.** Esc, or picking another tool, leaves sketch mode. Esc *during* a drag cancels only that stroke.
- **Other controls.** Pan with the middle button or Space+drag, and zoom with the wheel, both still work.
- **Shortcuts in text fields.** Shortcuts are ignored in text fields, as in v1.

### 5.3 The stroke and the live ghost (option 1)

**Stroke start (pointer down)**
- **On empty table.** The start pose is the pointer position at the toolbar's current level. The heading is unknown until the pointer has moved about 0.5U. It is then taken from the drag direction, snapped to 22.5° steps, or 45° with Shift.
- **Near an open connector** (within the v1 snap radius). The stroke continues from it: same pose, same level, heading set.
- **On a buffer stop** (on the piece, or within the snap radius of its connector). The stroke continues from the buffer's connector. On release the buffer stop is **removed**, and the new track starts at that connector. It becomes "the right straight or curve" automatically, because the ghost's first piece is whatever fits the line.
- **On the middle of existing track.** See §5.7 (switch creation).

**Growing the ghost (pointer move)**
- The ghost has a **leading end**: a pose and a level.
- Whenever the stroke's newest point is more than a set distance past the leading end (**builder's call**, about 0.75U), the app scores every allowed candidate piece.
- **Score.** For each candidate, the app looks at the point about 1U ahead of the leading end along the stroke. The score is the distance from the candidate's end to the stroke at that point, plus a penalty for heading error, plus a small turn penalty to discourage zig-zags. The lowest score wins.
- The winning piece is appended to the ghost and **a click plays**. A ghost piece is never revised during the drag, except by the release tidy-up.
- **Freehand candidate set:**
  - straights `straight-1-4`, `straight-1-2`, `straight-1`;
  - curves `curve-l-22`, `curve-s-45`, `curve-m-45`, `curve-l-45`, each left or right.
  - Straights are merged on release (§5.4).
- **Shift held:** the candidates are `straight-1`, plus `curve-m-45` and `curve-l-45` left or right, and only pieces that keep the heading on a multiple of 45° are allowed. Shift can be pressed or released mid-stroke and affects only the pieces laid from then on.
  - **Heading not on a 45° direction** (after a 22.5° curve, or when starting from track at 22.5°): the Shift set also allows a single `curve-l-22` left or right, so the heading can get back onto the 8 directions (my call).
- **Lag.** If the pointer moves fast, several pieces may be appended in one move event, each with its own click; the rate limit is in §5.9. If the pointer goes backwards over the ghost, nothing is removed. Esc cancels the whole stroke instead.
- **Drawing.** The ghost is drawn at 50% alpha in the current style. Its leading end shows a small dot.

### 5.4 Release: tidy-up and commit

On pointer up:
1. **Trim.** Drop the last ghost piece if the pointer never got more than halfway past it.
2. **Resolve the end:**
   - **Near an open connector or a buffer stop** (within the snap radius, same level): run the **join solver** (§5.6) from the ghost's leading end to that connector. A buffer stop is removed. The solver may replace the last one or two ghost pieces to find a solution. If none is found, the stroke ends where it is, with a buffer stop and the usual near-miss ring.
   - **On the middle of existing track:** create a merging switch (§5.7). Then run the join solver from the leading end to the switch's branch connector.
   - **Otherwise:** add a **buffer stop** at the leading end.
3. **Start end.** If the stroke started on empty table, add a **buffer stop** at the start, facing outward.
4. **Merge straights.** Merge consecutive straights into the fewest catalogue straights (2, 1, ½, ¼), with any remainder as a flex straight. This keeps piece counts sane.
5. **Commit.** The whole stroke is committed as **one command**:
   - the new pieces;
   - removed buffer stops;
   - converted or split existing pieces;
   - inserted crossings.

   It goes through `withLifting` for every existing piece it removes or replaces, so trains on them are lifted as in v1.
6. **Too short.** A stroke shorter than 0.5U total is ignored and treated as a click.

### 5.5 Levels: `+` / `−` while dragging

- **Pressing a key** sets a *pending ramp* up or down. The level is clamped to 0..`MAX_LEVEL`, and a key press that would leave that range is ignored, with a short low "bonk" sound.
- **Placing the ramp.** While a ramp is pending, the candidate set is **straights only**. Once the stroke allows 2U of straight, a `ramp-2` is appended, entered from its low end for `+` or its high end for `−`, with a click. Everything after it is at the new level.
- **The ghost** shows the pending ramp as a small "↑" or "↓" badge at the leading end.
- **Raised straights.** Raised straight track (level ≥ 1) laid by sketch uses `bridge-1` / `bridge-2` where it passes over lower track, and plain straights elsewhere. **Builder's call:** whether to decide this per piece at release.

### 5.6 Join solver (used by release tidy-up and near-miss click)

- **Input:**
  - a start pose `A`: position, outward heading and level;
  - a target connector `B`: position and heading, same level;
  - the pieces it may consume (re-solve over): trailing ghost pieces for sketch release, or neighbouring plain straights and curves for a near-miss click (§5.1).
- **Output:** a short chain of pieces whose start fits `A` and whose end mates exactly with `B`, or "no solution".
- **Method:**
  1. **Exact catalogue pieces.** If the remaining gap can be closed with catalogue pieces alone (for example a straight of an exact catalogue length along the heading), use those.
  2. **Otherwise, a biarc:** two circular arcs joined tangentially, which connects any two poses in general, plus optional flex straights. Each arc must satisfy the flex-curve limits (radius ≥ R_S, sweep ≤ 45°). A single arc beyond 45° may be split into several flex curves.
  3. **Fallback.** If still impossible, the solver drops up to two of the pieces it may consume and retries from the earlier pose.
- **Builder's call:** the exact biarc parameterisation and the search order.
- **Requirement:** the result must join exactly, within the v1 `JOIN_POS_TOL` / `JOIN_ANGLE_TOL`.

### 5.7 Starting or ending on the middle of existing track → switch

- **Where it can happen.** Only on **plain straight** track at the stroke's level: catalogue straights and flex straights. Bridge and tunnel pieces never become switches (my call). There are no bridge or tunnel switch pieces, and turning one into a plain switch would lose its look.
- **Snapping the switch position.** If the pointer is on a curve, crossing, ramp or switch, the switch position snaps to the nearest straight stretch within the snap radius. If there is none:
  - **at the start of a stroke,** the drag doesn't begin, and the cursor shows "not allowed" (my call);
  - **at the end of a stroke,** the stroke is committed up to its last good piece and ends in a buffer stop, as for curved crossings in §5.8 (my call).
- **Building the switch:**
  - A **1U `switch`** replaces that section of straight track, centred on the nearest valid point. The neighbouring remainder is filled with catalogue straights, plus a flex straight if needed. The section must lie within one straight piece, or across joined straight pieces.
  - **Branch side:** the side of the track the stroke heads towards. The switch's `flipped` is set accordingly.
  - **Facing direction:** so that the branch leads the way the stroke is going.
  - The stroke's first ghost piece starts at the switch's branch connector, with heading 45° off the track.
- **Ending a stroke** on the middle of straight track builds the mirror image: a **merging switch** whose branch faces the incoming stroke. The join solver connects to its branch connector.
- **Defaults.** The new switch gets default switch settings (manual mode, state 0).

### 5.8 Crossing existing track

- **When it applies.** If the next ghost piece's route would cross a same-level route of existing track, or of the stroke's own earlier ghost:
  1. **Where.** Find the crossing point and the crossing angle.
  2. **Which crossing piece.** Choose `crossover-90` or `crossover-45`, whichever angle is nearer. The existing track there must be **plain straight**, not a bridge or tunnel piece (my call); see the red case below.
  3. **Place it.** Insert the crossover centred on the crossing point, aligned with the existing track. The existing straight is split around it, with straights plus flex as in §5.7.
  4. **Join the ghost.** Join the ghost's leading end to the crossover's entry connector with the join solver. This is the "nudge", and it may rework up to two trailing ghost pieces. The ghost then continues from the crossover's far connector.
- **Curved existing track, or a bridge or tunnel piece,** at the crossing point: the stroke turns red from that point onward, and release commits only up to the last good piece, ending in a buffer stop. The way round is to press `+` first and bridge over.
- **Track on another level** is not "crossed". This is how bridges work.

### 5.9 Click sound

- **The sound.** A short (about 15 ms) soft filtered-noise or sine "tick", generated with Web Audio at low gain (−24 dBFS or quieter). Pitch varies slightly between ticks so long strokes don't drone.
- **When it plays:**
  - Once per ghost piece appended.
  - At most one click per 40 ms, so extra clicks within 40 ms are dropped.
  - On a successful release tidy-up: a slightly different "settle" tick.
  - On an out-of-range level key: a low "bonk".
- **Mute.** A **Sound** on/off toggle in the toolbar, on by default. It is a per-browser preference stored in `localStorage` (try/catch), not saved in layout files.
- **Starting audio.** The AudioContext is created or resumed on the first pointer-down, because browsers block audio until the user interacts.

### 5.10 Buffer-stop reversal (changes v1 §5.5 "Dead ends")

- **At a buffer stop.** A **running** train that comes to rest at the end of a **buffer stop's** route:
  1. waits **2 seconds of simulation time** (time while paused doesn't count);
  2. then reverses, exactly like `Simulation.reverse`;
  3. then sets off again (`running` stays true) and accelerates to its set speed.
- **At a bare open end** (no buffer piece), a train still brakes and stays stopped, as in v1.
- **Interruptions.** If, during the wait, the train is stopped by the user, crashed, lifted or deleted, the pending reversal is cancelled.
- **Starting again.** Pressing Run on a train standing at a buffer starts a new 2 s wait, then reverses.
- **Collisions.** If reversing would immediately collide (a train right behind), the normal collision rules apply. With the v1 "heading toward" rule, the reversed train is the one heading in, so a crash is flagged; that is acceptable.
- **Tests.** v1 tests that assume "stops at buffer and stays stopped" are updated. The open-end tests stay as they are.

### 5.11 Rendering additions
- **Stroke and ghost.** The raw stroke is drawn as a thin translucent line under the ghost while dragging. The ghost draws as in §5.3, and any red part of the stroke is drawn red.
- **Switch preview.** Where a switch will be created, a preview of the switch outline is shown.
- **Flex pieces.** Flex pieces render in every style (§5.1). In the palette they get thumbnails from their default parameters.

## 6. Left to the builder
- The exact scoring weights, look-ahead distance and step threshold for the ghost (§5.3). Tune them by trying real strokes, and record the values in code constants.
- The biarc maths and search order (§5.6).
- How flex geometry is threaded through the catalogue accessors (§5.1).
- The sound synthesis details, within §5.9.
- How bridge pieces are picked for raised straights (§5.5).

## 7. Decisions made by Claude, not the user (for review)
- **Flex limits.** Flex straight 0.05–4U; flex curve radius R_S–8U, sweep ≤ 45°.
- **Resizing and closing gaps.** Flex resize uses end handles, with Alt to change a curve's radius. Clicking a near-miss ring closes it with flex pieces.
- **Save format.** It moves to version 2, and v1 files migrate.
- **Sketch entry.** S key and a toolbar button.
- **Stroke rules.** Strokes shorter than 0.5U are ignored. Esc cancels the stroke in progress.
- **Candidate sets.** Freehand uses ¼, ½ and 1 straights plus all 45° curves and the large 22.5° curve. Shift uses straight-1 and medium/large 45° curves on the 8 directions.
- **Merging straights.** Consecutive straights are merged on release.
- **Switches.** They are made only on plain straight track (not bridges or tunnels); elsewhere the position snaps to nearby straight track. Ending on the middle of track makes a merging switch.
  - With no valid spot, a stroke can't start there; a stroke ending there is committed up to its last good piece, with a buffer stop.
- **Crossings.** These need plain straight existing track; on curved, bridge or tunnel track the stroke turns red from that point.
- **Closing near misses.** A near-miss click may replace up to two neighbouring plain straights or curves on each side with flex pieces.
- **Flex resize.** Handles work on any open end, including a loose piece.
- **Shift off the 45° directions.** The Shift set allows one 22.5° curve to get back onto the 8 directions.
- **Ramps.** `+`/`−` defers the ramp until 2U of straight is available. Out-of-range presses are ignored, with a "bonk".
- **Buffer reversal.** It applies to buffer stops only, not to bare open ends. The 2 s wait counts simulation time.
- **Sound.** It is on by default with a toolbar toggle and is stored per browser, at most one click per 40 ms.
