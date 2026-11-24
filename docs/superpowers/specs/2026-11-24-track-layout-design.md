# Track Layout — Design

Date: 2026-11-24
Status: Draft, awaiting approval (builder check done)

## 1. Intent

An on-screen toy train set. It should feel like building on a tabletop with
wooden toy track, but with the precision and comfort of a CAD tool and a
larger variety of pieces than a physical box set. You lay out track from a
palette in a top-down view, drop trains on it and set them running.

It is a sandbox: no goals, scoring or levels. A session is satisfying when
building is fluid (pieces click together, loops close, mistakes are one
Ctrl-Z away) and the result is fun to watch run.

**Player (confirmed):** an adult tinkerer on a desktop or laptop with mouse
and keyboard. Keyboard shortcuts and precise mouse control are fine.

## 2. Goals, non-goals, anti-goals

### Goals (v1)

- Top-down editor with a palette of track pieces, shown in the current visual style.
- Pieces snap connector-to-connector; a grid helps when placing loose pieces; free placement is available.
- Piece set: straights, curves in several radii, switches, crossovers, ramps, bridges, tunnels, buffer stops.
- Three switchable visual styles: **wooden toy**, **model train**, **LEGO-style**.
- Switches with two modes: **manual** (click to toggle) and **auto** (flips each time a train goes through).
- Trains of variable length that you place on the track, start, stop, reverse and give a speed.
- Collisions between trains, with a global on/off setting.
- Simple levels: raised track, ramps between levels, bridges over lower track, decorative tunnels.
- Optional hill effect: trains slow going up ramps and speed up going down (global on/off setting).
- Undo and redo (Ctrl-Z, Ctrl-Shift-Z or Ctrl-Y) for every edit.
- Save and load layouts as human-readable text (JSON) files.

### Non-goals (v1)

- Matching real product ranges, parts lists, or physical-accuracy constraints.
- A 3D view or true 3D stacking (supports, layers three deep, etc.).
- Goals, scoring, cargo, timetables, signals, or block control.
- Touch and mobile support, beyond not being broken on a tablet.
- Multiplayer, online sharing, or accounts.
- **Flex track** (deferred to v2): short adjustable pieces that bridge an "almost" connection. v1 only flags near-misses (§5.3). Keep the piece model open to a piece whose geometry is set per instance.

### Anti-goals (failure even if it "works")

- Fiddly alignment: loops that won't quite close, or pieces that need pixel-hunting to join.
- Trains derailing, vanishing or getting stuck for reasons the player can't see.
- Losing work: an accidental reload or a bad click wiping out a layout.
- Editing that feels like a form-filling app rather than playing with track.

## 3. Constraints

- Runs in a modern desktop browser (Chrome, Firefox, Safari, Edge; current versions). No install, no server.
- Written in TypeScript.
- Drawn with the plain HTML canvas 2D API; no graphics library (see §4).
- Save files are plain text and stay readable and hand-editable.

## 4. Approaches considered

| Option | Summary | Trade-off |
|---|---|---|
| **1. Plain canvas 2D, drawn in code** *(chosen)* | Each style is a set of drawing routines for pieces, trains and background | Simplest; no dependency; easily handles hundreds of pieces. May slow down on very large layouts, and rich effects are hard. |
| 2. PixiJS (GPU 2D) | Same flat look, GPU-accelerated, texture-based styles | Smooth with thousands of pieces and allows real textures. Adds a dependency and texture-caching complexity. |
| 3. Three.js, fixed top-down camera | Real 3D underneath | Real depth and lighting. By far the most work, since every piece needs a 3D model in three styles, and it pulls toward the 3D view deferred from v1. |

**Picked: option 1**, which the user chose. The renderer is kept behind an
interface, so moving to option 2 later only means replacing the drawing layer.

## 5. Design

### 5.1 Architecture

Four layers. Only the last one knows about the canvas.

1. **Model**: pieces, connections, trains and settings. Plain data, serialisable.
2. **Geometry and track graph**: piece definitions, connector maths, and the routes trains follow.
3. **Simulation**: train movement, switches, collisions and the hill effect. Runs on a fixed timestep independent of the frame rate.
4. **Editor and renderer**: input handling, commands and undo, the palette and panels, and drawing to the canvas.

Model, geometry and simulation are pure TypeScript and unit-testable without a browser.

### 5.2 Piece system

All pieces share one unit, **U** (the length of a standard straight), so that
layouts close neatly the way wooden sets do.

Each piece **type** defines:

- **Connectors:** a local position, an outward heading, and a level offset (0, or +1 for the high end of a ramp). Each has a polarity of male or female, as in wooden track.
- **Routes:** internal paths between pairs of connectors, each made of straight-line and circular-arc segments. A train always follows a route.
- **Footprint:** the outline used for hit-testing and drawing.

**Starting catalogue.** The builder sets exact sizes; the catalogue is data, not code.

| Family | Pieces |
|---|---|
| Straight | ¼U, ½U, 1U, 2U |
| Curve | three radii (small, medium, large), each 45° so 8 make a circle; plus 22.5° versions of the large radius |
| Switch | left and right (a straight route plus a 45° branch); a Y switch (two 45° branches) |
| Crossover | 90° and 45° (two routes that cross without connecting) |
| Ramp | 2U long, rising one level |
| Bridge | a raised straight (1U and 2U) drawn with a deck and supports |
| Tunnel | a cover placed over ground-level straights or curves (decorative only) |
| Buffer stop | a single-connector end piece |

**Mirroring:** curves and switches can be flipped instead of having separate
left and right definitions where that is simpler. This is the builder's call.

**Male and female connectors:** they are drawn, because that is part of the
wooden-toy charm, but **not enforced**. Any two connectors join. *(My call: enforcing them would add exactly the fiddliness listed in the anti-goals.)*

### 5.3 Placement and snapping

**Catalogue geometry must close exactly** for common combinations (my call, since flex track waits for v2):
- A switch branch has the same geometry as a catalogue curve.
- Curve radii differ by a fixed spacing, so concentric curves make evenly spaced parallel track.
- A switch followed by a reverse curve gives a parallel track at that same spacing.
- Straight lengths combine to match the sideways and forward offsets of curves where practical.

Unit tests must check that standard loops close: a circle, an oval, a figure-eight over a bridge with ramps, and a passing loop.

- **Placing from the palette:** pick a piece, and a ghost copy follows the cursor.
  - Near an open connector on the layout, the ghost attaches to it.
  - **Tab** cycles through which of the ghost's connectors attaches.
  - **R** (or the mouse wheel while placing) cycles orientation where that makes sense, for example a curve turning left or right.
  - Click to place.
  - **Keep placing (my call):** after a click the piece stays selected and the ghost moves to the new open end. This makes laying a run of track fast. Esc or right-click stops.
- **Snapping, in priority order:**
  1. **Connector snap** (primary), to the nearest compatible open connector within a screen-space radius.
  2. **Grid snap**, used when no connector is in range. The piece origin snaps to grid points and the rotation snaps to 22.5° steps. The grid spacing is ½U and the grid is visible.
  3. **Free placement:** holding **Alt** disables both snaps.
- **Auto-join:** after any placement or move, every open connector pair that lines up within a small tolerance is joined. The tolerance is roughly 1% of U in position and 1° in heading. This is what makes loops close. Pairs that nearly line up but miss the tolerance get a visible "almost" marker, so a loop that is slightly off is obvious rather than silently broken.
- **Selecting and moving:** click to select, Shift-click or drag a box to multi-select. Dragging moves the selection, and the moved group snaps to connectors like a single piece does. Q and E rotate the selection by 22.5°. Delete or Backspace removes it.
- **Connected moves:** a drag moves only the selected pieces, and joins to unselected pieces break. Double-click selects a whole connected section.
- **View:** pan with a middle-button drag or Space+drag, and zoom with the wheel around the cursor. A "fit layout" button. The table is unbounded.
- **Overlapping track:** pieces on the same level may overlap without a crossover. That is allowed, but the overlap is highlighted, and trains there are treated as on the same level for collisions.

### 5.4 Levels, ramps, bridges, tunnels

- **Levels:** every piece has an integer level, where 0 is the ground. The highest level is the builder's call (suggest 3).
- **Connections:** connectors join only at the same level. A ramp's low end sits at the piece's level and its high end at level+1.
- **Placing a piece:** a piece attached to a connector takes that connector's level. Placed loose, it takes the "current level" set in the toolbar (default 0).
- **Drawing order:** pieces and trains are drawn by level, lowest first. Raised track casts a soft shadow onto the level below, and ramps blend between the two levels.
- **Bridges:** any track at level ≥1 is "raised". Bridge pieces add the deck and supports for looks. Their real job is that trains on different levels never collide.
- **Tunnels:** a decorative cover drawn above ground-level track *and* the trains on it, so trains disappear inside and reappear at the other end. A tunnel does not affect the simulation.

### 5.5 Trains

- **Makeup:** a train is a locomotive plus 0 to N cars (the builder sets the cap; suggest 20). The car count is set when placing the train and can be edited later in the train's panel.
- **Placing:** choose "Add train", hover over the track, and a ghost train lies along the routes from the cursor. Click to place, and Tab flips its direction. Placing is refused if the train would run off an open end.
- **Controls, per train:** run/stop, reverse, and a speed slider. **Global:** pause/play for everything. A selected train shows a small floating panel.
- **Moving:** each car follows the track path at a fixed spacing behind the one in front. Speed is in U per second, with gentle acceleration and braking rather than instant changes.
- **Dead ends:** at a buffer stop or open connector, the train brakes to a stop at the end. *(My call: it does not reverse automatically.)*
- **Ownership:** trains are part of the layout and are saved with it.
- **Lifted trains:** a train can be *lifted*, meaning off the track and drawn as a translucent ghost at its last position. A lifted train does not move or collide. You drop it back with the same placement as "Add train", or delete it.

### 5.5a Editing while trains run

Editing is always allowed, including while the simulation is running.

- **Pieces a train is on:** moving, rotating or deleting a piece that any car of a train is on (or partly on) **pauses that train and lifts it**. A deleted piece's train is lifted rather than deleted. *(This replaces the earlier "delete with it" rule; the user confirmed it.)*
- **Unaffected trains:** they keep running. If an edit removes the track ahead of a train, it brakes at the new open end as at any dead end.
- **Switches:** a switch can't be toggled while a train is on it (see §5.6).
- **Undo and trains (my call):** commands record train state at edit time.
  - Undoing an edit that lifted trains puts those trains back where they were, **stopped**.
  - If a train's old spot is now occupied by another train, or its track no longer exists, it stays lifted instead.
  - Running trains that the undone edit didn't touch are left alone.

### 5.6 Switches

- **Facing direction** (entering at the single end): the switch state picks the route.
  - **Manual mode:** clicking the switch (while not placing) toggles it. The current state is clearly drawn, for example a lever or an arrow.
  - **Auto mode:** the switch flips **after the last car of a train has cleared it in the facing direction**, so trains alternate branches.
- **Trailing direction** (entering from a branch): the train always gets through, and the switch lines itself up to the branch the train came from, like spring-loaded toy switches. Trains never derail at a switch.
- **Mode:** each switch's mode is set in its panel. New switches default to manual.
- **Two trains on one switch:** if a facing train arrives while another train occupies the switch, the switch keeps its state until it is clear. This avoids splitting a train.

### 5.7 Collisions

- **Setting:** global on/off, default **on**.
- **Detection:** two trains collide when their cars overlap on the same level. Cars are approximated as rectangles or, more simply, by their positions along the track. The method is the builder's call, but it must work at crossovers and overlapping track.
- **When on:** both trains stop immediately and show a crash marker at the point of contact. The crash clears when either train is reversed, moved or deleted. No derailing or scattered cars.
- **When off:** trains pass through each other.

### 5.8 Hill effect

- **Setting:** global on/off, default **off**.
- **When on:** a train on a ramp gets a speed change proportional to the slope, slower going up and faster going down. The change is smoothed so it doesn't jerk, and the train returns to its set speed on level track. The builder tunes the constants, but going uphill must never stall a train.

### 5.9 Visual styles

- **Setting:** a global style picker that switches instantly. Each style provides drawing routines for the background (the table surface), every piece type, switch states, trains and cars, and the tunnel and bridge covers.
  - **Wooden toy:** a light wood track band with two carved grooves and peg-and-hole connectors, chunky coloured wooden trains, and a light wood table.
  - **Model train:** a ballast bed, sleepers and steel rails, scale-looking locos and cars, and a grass or layout-board background.
  - **LEGO-style:** grey plate track with studs and rail strips, blocky brick-built trains, and a green baseplate with studs. It must evoke the style without copying any trademarked look or logo.
- **Palette thumbnails:** drawn by the same routines, so they always match the current style.
- **Train colours:** each train has a colour, chosen in its panel, which every style respects.
- **Screens:** drawing is HiDPI-aware.

### 5.10 Undo and redo

- **Mechanism:** every edit is a command with do and undo, and is reversible. Undo is Ctrl-Z (Cmd-Z on macOS). Redo is Ctrl-Shift-Z or Ctrl-Y (Cmd-Shift-Z).
- **Undoable:** placing, moving, rotating and deleting pieces. Placing, moving and deleting trains. Changing a switch's mode, a train's car count or a train's colour. A multi-piece drag or a delete counts as one undo step.
- **Not undoable** (these are play, not edits): toggling a switch by clicking it, starting, stopping or reversing a train, changing speed, simulation progress, and changing the view.
- **Deleting a piece with a train on it:** the train is lifted (§5.5a), as part of the same undo step.
- **History:** at least 200 steps. It is not saved with the file.

### 5.11 Save and load

- **Format:** JSON with a `format` name and a `version` number, so old files can be migrated.

  ```json
  {
    "format": "track-layout",
    "version": 1,
    "style": "wooden",
    "settings": { "collisions": true, "hillEffect": false, "gridVisible": true },
    "pieces": [
      { "id": "p1", "type": "curve-m-45", "x": 0, "y": 0, "rotation": 0, "level": 0, "flipped": false },
      { "id": "p7", "type": "switch-left", "x": 2.0, "y": 0, "rotation": 90, "level": 0,
        "switch": { "mode": "auto", "state": "branch" } }
    ],
    "trains": [
      { "id": "t1", "cars": 4, "color": "#c0392b", "speed": 1.5, "running": false,
        "head": { "piece": "p1", "route": 0, "distance": 0.3, "direction": "forward" } }
    ]
  }
  ```

- **Field rules:**
  - Positions are in units of U and rotations are in degrees.
  - Connections are **not stored**. They are recomputed by auto-join on load, so a hand-edited file can't hold inconsistent connections.
  - The exact field names are the builder's call, but the format must stay readable by a person.
- **Saving and loading:** Save downloads a `.json` file, and Open loads one through a file picker or by dropping it onto the window.
- **Bad files:** a file with an unknown version or invalid data shows a clear error and leaves the current layout untouched.
- **Autosave (my call, to guard against lost work):** the current layout is kept in browser storage and restored on reload, with a "New layout" action to start fresh.

### 5.12 Screen layout

```
┌─────────────────────────────────────────────────────────────┐
│ New Open Save │ Undo Redo │ Style▾ │ Level▾ │ ☐Collide ☐Hills │ ▶/⏸ │
├──────────┬──────────────────────────────────────────────────┤
│ PALETTE  │                                                  │
│ Straight │                                                  │
│ Curves   │            canvas (top-down table)               │
│ Switches │                                     ┌──────────┐ │
│ Crossing │                                     │ Train 1  │ │
│ Ramps    │                                     │ ▶ ⇄ ───● │ │
│ Bridges  │                                     └──────────┘ │
│ Tunnels  │                                                  │
│ + Train  │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

The panels are plain DOM around a single canvas. *(My call: there are few
enough panels that no UI framework is needed.)*

### 5.13 Tooling (builder's call, suggested)

- Vite for development and building, and Vitest for unit tests.
- Test geometry, snapping, auto-join, routing through switches, train movement, collisions, undo and redo, and a save-and-load round trip.
- The output is a static site.

## 6. Left to the builder

- Exact piece sizes, the value of U, the maximum level, and the car cap.
- Drawing detail and colours for each style, within the descriptions above.
- Simulation constants: acceleration, the hill-effect factor, and snap radii.
- How collisions are detected, provided it meets §5.7.
- Code structure within the four layers, and the exact JSON field names.

## 7. Decisions made by Claude, not the user (for review)

- Connector-to-connector snapping is primary, and the grid is secondary.
- Male and female connectors are drawn but not enforced.
- Keep-placing mode when laying track.
- Trains stop at dead ends rather than reversing.
- Collisions default to on, and the hill effect defaults to off.
- Toggling switches and starting or stopping trains are not undoable.
- Catalogue geometry closes exactly, with tests for standard loops.
- Undo puts lifted trains back stopped, or leaves them lifted if their spot is taken.
- Autosave to browser storage.
- Connections are not stored in the file.
- No UI framework.
