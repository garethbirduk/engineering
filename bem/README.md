# bem

Interactive 2D **Boundary Element Method** solver for linear elasticity, with a browser-based CAD editor and live results. Port of the DBE-SBFEM machinery from Bird's 2012 Durham thesis to TypeScript end-to-end — no backend, no server, no Python.

See [`../thesis/PORT.md`](../thesis/PORT.md) for the design notes that drive this port.

---

## Highlights

- **Sketch → solve → visualise** in one tab. Draw geometry, set boundary conditions, watch displacement and stress fields update as you tweak the model.
- **Real BEM solver** running in the browser. Quadratic isoparametric elements, Kelvin kernels, Gauss-Legendre with Telles transformation for singular integrals, dense LU.
- **Reanalysis cache** — only the H/G block pairs that touch a modified element get re-integrated. Drag a point and the solver reuses everything that didn't change.
- **Plate-with-hole** demo bundled — opens on first visit, gives a textbook Kt ≈ 3 stress concentration out of the box.

---

## CAD editor

Gesture-based, no modes. Everything you can do, you can do by clicking:

| Gesture | Action |
|---|---|
| **Double-click empty** | Add a Point at the snap |
| **Double-click Point + drag** | Draw a new Line from that Point |
| **Double-click Line + drag** | Split the Line and drag the new Point |
| **Click + drag Point/Line** | Move it |
| **Click an entity** | Select (replace selection) |
| **Shift+click** | Toggle in multi-selection |
| **Marquee drag on empty** | Box-select |
| **Shift + drag** | Pan |
| **Middle-mouse drag** | Pan |
| **Scroll wheel** | Zoom |
| **Del / Backspace** | Delete selection |
| **Esc** | Clear selection / cancel draft |

Lines can be straight or **arcs** (toggle via the Inspector — a centre Point appears and the line bulges; flip the centre to swap the bulge direction). Closed loops of selected lines become **Boundaries**; one or more Boundaries become a **Domain** (outer + holes are handled separately via even-odd fill).

### Boundary conditions

Per Line, per axis (x or y), choose **displacement** or **traction**. Unset axes default to traction = 0 (free surface). Units are auto-prefixed (MPa for traction, mm for displacement by default) — switch the prefix per BC entry to anything from femto- to peta-.

### Discretisation overrides

Default is two quadratic elements per Line with the discontinuous nodal scheme (η = ±2/3, 0). Per Line — or per element within a Line — you can override:

- Elements per Line
- Local η coordinates of the three nodes (continuous {-1, 0, +1}, discontinuous, or either semi-discontinuous variant — or freeform)
- First-distinct / last-distinct / all-distinct flags for clean corner handling

---

## Solver

**Engine (`@bem/engine`).** Pure TypeScript library, no DOM, fully testable:

- Quadratic isoparametric line elements (arcs handled by sampling true geometry at η = -1, 0, +1)
- Kelvin fundamental solutions for 2D plane stress / plane strain
- 10-point Gauss-Legendre quadrature with Telles cubic transformation for nearly-singular and singular kernels
- Boundary-walk row order: H and G rows ordered boundary → line → element → node → axis, so adjacent rows correspond to geometrically adjacent DOFs (visible directly in the Matrix view)
- Reanalysis cache keyed by `(collocation, field-element, material)` triples — `solve()` returns SolveStats showing G-evals done vs. cached
- Boundary stress recovery via Kelvin tangential-strain + applied-traction (used by every "stress at the boundary" readout — exact, no near-singular Somigliana)

---

## Results

A point you draw is more than just geometry — once a Domain exists and BCs are set, the **Results panel** lights up with:

### Interior fields (contoured on a Delaunay triangulation of BEM nodes + interior post-process nodes)

- **Displacement:** ux, uy
- **Cartesian stress:** σxx, σyy, τxy
- **Derived stress scalars:** σvm (von Mises), σ1 / σ2 (principals), τmax (max in-plane shear)
- **Kt — stress concentration factor:** σvm / σ_ref, where σ_ref is the largest applied traction magnitude across all BCs. The plate-with-hole demo gives Kt ≈ 3 at the hole top/bottom, as expected.

Boundary-adjacent triangulation vertices use Kelvin recovery (not Somigliana) so peak values at hole edges show exact stress, not smoothed neighbour averages. First-ring interior nodes near sharp geometry corners are pushed further out so spurious corner spikes don't pin the colour scale.

### Edge profile (along selected boundary Lines)

Pick any field, then select one or more Lines — the panel plots that field along arc length. Multiple selected Lines concatenate in selection order with a vertical separator at each line transition. Hover the plot for a crosshair readout snapped to the nearest sample.

### Slice tool

New: toggle **Slice** in the toolbar, then click-drag a cutting line anywhere across (or beyond) the domain. The Results plot switches to that slice profile:

- Samples that fall inside the material show the live field
- Samples that fall in a hole (or outside the outer boundary) drop to zero
- Step transitions at the boundary use Kelvin recovery, so the values right at hole edges are exact

A new click-drag immediately replaces any previous slice. Esc or toggling Slice off clears it.

### Colour scale

11-band diverging (red→green→blue) for fields that can swing either way; sequential (blue→red) for ≥ 0 fields (σvm, τmax, Kt). Band edges are explicitly labelled — the topmost label is the data max, the bottommost is the data min (or 0). The scale spans the **true** data extreme — no percentile clip eating the peak.

---

## Debug / explanation panels

This is a teaching tool as much as a solver. Toggles on the toolbar:

- **Mesh** — derived BEM mesh overlay (elements + nodes)
- **Internal nodes** — interior post-process node placement (wave-front ring schedule, visible)
- **Boundary results** — dashed deformed-shape overlay from the solve
- **Matrix** — `H · u = G · t` system schematic. Hover the schematic to highlight the source element and collocation node on the canvas; hover the canvas to highlight the corresponding row/column. Reverse hover works in both directions.
- **Labels** — every element gets a `D{n} B{n} L{n} E{n}` address tag plus its three local node numbers (1, 2, 3), so you can correlate canvas elements with matrix rows
- **Equations** — pick a collocation node + a source element and the Inspector renders the 2×6 `H` and `G` submatrices for that pair (the kernel integrand at every Gauss point on the source, integrated)
- **Slice** — see Slice tool above

---

## Files

Save and reload as JSON (download or local-storage), with a versioned schema. Backwards compatible via the deserialise migration in `engine/src/serialize.ts`.

The bundled `plate-with-hole.json` is what the page opens to on first visit.

---

## Layout

```
bem/
├── engine/      @bem/engine    — pure TS library: maths, kernels, assembly, solver
├── webapp/      @bem/webapp    — Vite + React 18 + TypeScript, gesture-based CAD editor
└── headless/    @bem/headless  — tsx CLI for batch / convergence runs
```

`engine` is dependency-free, browser- and Node-compatible — it's what the webapp imports, what `headless` drives, and what the tests cover.

---

## Commands

```bash
npm install              # one-shot at root, hoists deps via workspaces
npm run dev              # vite dev server (webapp)
npm test                 # vitest across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run build            # build all workspaces
```

Workspace-specific:

```bash
npm test --workspace=@bem/engine
npm run dev --workspace=@bem/webapp
```

---

## Status

Working, useful, and actively iterated on. Convergence is clean for the discontinuous scheme on the canonical biaxial-tension test; continuous-scheme corner handling has known limitations documented in [`TODO.md`](TODO.md). SBFEM port is still in progress — current focus is the BEM half.
