# BEM Solver Strategy — Caching & Reuse Architecture

> Design doc captured before the real BEM kernel is built. The aim is a
> solver that feels instantaneous on small problems and scales to bigger
> ones by *reusing* every piece of expensive work that hasn't been
> invalidated by the user's last edit.

Companion to:
- `2-BEM.md` (chapter 2 summary)
- `PORT.md` (overall port roadmap)

---

## 1. What a 2D direct BEM solve actually does

For each problem:

1. **Discretise** every boundary line into quadratic elements; each element
   has 3 nodes at chosen local η coords (continuous, discontinuous, or
   mixed — see meshing config in the editor).
2. **Gauss-point setup** per element: for each Gauss point `g`, compute
   - world position `x(η_g)` via isoparametric shape functions
   - Jacobian `J(η_g)`
   - outward unit normal `n(η_g)`.
3. **Assemble H, G** (size `2N × 2N`, `N` = total nodes): for every
   `(collocation node i, source element j)` pair, integrate the kernels
   - `G_ij = ∫ U*(x_i, x(η)) · N(η) · J(η) dη`
   - `H_ij = ∫ T*(x_i, x(η), n(η)) · N(η) · J(η) dη`
4. **Diagonal H block**: use the rigid-body trick
   `H_ii = -Σ_{k≠i} H_ik` (avoids the worst singularity).
5. **Apply BCs**: rearrange `H u = G t` into `A x = b`, where `x` is the
   unknowns and `b` is built from the known DOF values.
6. **Solve** `A x = b` (LU factor + back-sub).
7. **Backfill** the mesh: known DOFs already there, unknown DOFs now
   have values.

## 2. Where the time goes (rough cost ranking, biggest first)

| Cost | Reason |
|---|---|
| **Pair-wise kernel integrals (step 3)** | `O(N_el²)` pairs × `O(GaussPoints)` per pair × kernel calls inside. The whole point of caching. |
| **LU factorisation of A (step 6)** | `O((2N)³)` for dense. Dominates large problems. |
| **Per-element Gauss setup (step 2)** | `O(N_el × GaussPoints)`, much smaller but called on every entry, so adds up. |
| Singular near-element integrals (step 3, diagonal/adjacent pairs) | Same `O(N_el²)` count but each one needs special-quadrature (Telles, log-weighted) — more expensive per pair. |
| Discretisation, BC fan-out, RHS assembly | Linear-time, cheap. |

## 3. What changes when the user does X

| User action | Invalidates |
|---|---|
| **Move a point** | Every element that uses that point as anchor (start/end/arc-centre or as a shape-function anchor of a neighbouring element). Other elements' geometry data stays valid. |
| **Change a BC value** (e.g. `tx = 100 → 200 MPa`) | Just the RHS `b`. **H, G, LU factor all reusable.** Solve is ~`O(N²)` back-sub instead of `O(N³)` factor. |
| **Change a BC kind** (t ↔ d) | The PARTITION of unknowns vs knowns changes → A is rearranged → LU factor invalidated. But H and G unchanged. Refactor + solve. |
| **Add a new element** (change `elementsPerLine`) | Only that line's elements rebuild. Other lines' element data still valid. Many H, G entries still valid; only rows/cols touching the new nodes change. |
| **Change material (E, ν)** | Kernels `U*` and `T*` depend on `ν` (and `E` is just a scalar on the displacement kernel for plane strain). So `G` scales / partially recomputes; `H` is `ν`-dependent too. Worth a separate cache check. |

## 4. Three layers of cache, each tied to a specific notion of "unchanged"

### Layer A — Per-element data

Keyed by the element's anchor positions (`start`, `end`, optional
`arcCentre`).

Contents:

- Gauss-point world positions
- Jacobian at each Gauss point
- Outward unit normal at each Gauss point
- Element length / `dx/dη` evaluations

Depends on **only** the 3 anchors of that element. *Mutation-free
implication*: if those 3 anchor positions are referentially the same,
the cache is valid.

### Layer B — Per-pair kernel contributions

Keyed by `(collocation_node, source_element)`.

Contents:

- The `G_ij` and `H_ij` sub-blocks (each is a `2 × 6` block: 2
  collocation DOFs × 6 element DOFs)
- The integration scheme used (regular Gauss / Telles / analytic-singular)
  is part of the cache key indirectly: same `(node, element)` pair
  always produces the same scheme.

Depends on **only** the position of the collocation point and the
geometry of the source element. *Mutation-free implication*: if neither
the node nor the element changed reference, the pair contribution is
valid. **This is the biggest win** — moving one point invalidates only
the rows/cols where that point appears OR where an element using that
point appears, leaving the rest of the `O(N²)` work intact.

### Layer C — LU factorisation of A

Keyed by the BC partition (which DOFs are known vs unknown) AND by H, G
being unchanged.

Contents:

- L, U matrices (or whatever decomposition)
- Permutation

Reused as long as Layer B is fully valid AND the BC kind-pattern is
unchanged. Only the RHS `b` changes.

## 5. How to enable the cache (the architectural enabler)

**Referential identity is the lever.** Caches keyed by object references
"just work" if `discretiseLines` preserves references for unchanged
parts of the mesh.

Concrete proposal:

- `discretiseLines(model, prevMesh?)` becomes ref-preserving:
  - For each line, hash a *small* tuple:
    `(line.id, startPoint, endPoint, arcCentrePoint, lineLevelBC, perLineMeshingConfig, ...elementOverrides)`.
  - If the hash matches the prior run for that line, return the prior
    `MeshElement[]` for that line **byref**.
  - Otherwise rebuild only that line's elements.
- Each `MeshNode` and `MeshElement` is an immutable object. Same-byref
  ⇒ same content.
- Side-table caches live in `WeakMap`:
  - `WeakMap<MeshElement, ElementGeometryCache>` for Layer A
  - `WeakMap<MeshElement, Map<MeshNode, PairContribution>>` for Layer B
  - WeakMap means a stale element gets garbage-collected naturally when
    it falls out of the live mesh.
- A `BemSystem` value alongside the mesh holds H, G, and the current LU
  factor (Layer C). It exposes `solve(model) → solvedMesh` and
  internally walks the WeakMaps for cached pair contributions, only
  computing the missing ones.

**Why side-tables, not fields on the mesh itself**: keeps `MeshElement`
/ `MeshNode` as pure-data records (good for serialization, equality,
immutability). Caches are an analysis concern — they live in the
analysis module, not the geometry module. Memory pressure is handled
by the GC automatically (WeakMap entries vanish when their key element
falls out of scope).

## 6. Pragmatic build order

1. **Walking skeleton, no caching.** A correct `solve()` that computes
   H, G from scratch every time. Validate against Williams expansion
   (the analytical oracle the thesis uses for cracked plates) for at
   least one trivial geometry. This will be slow but right.
2. **Layer A cache.** Per-element Gauss data via a side-table. Verify
   visual results unchanged.
3. **Ref-preserving `discretiseLines`.** Now Layer A caches actually
   get reused across edits. Measure the wall-clock difference when
   moving a point on a 20-element mesh.
4. **Layer B cache.** Pair contributions via the nested WeakMap. This
   is the big perf win; on a "move one point" interaction we should
   see most of `O(N²)` work skipped.
5. **Layer C cache.** Reuse LU factor when BC pattern unchanged.
   Smaller win at small N, growing at large N.
6. **Telles / analytic-singular** for the near-diagonal entries.
7. **Material caching** if needed (`ν` changes are rare enough we can
   probably eat the recomputation).

## 7. Two specific things worth flagging from the thesis

- **Outward normal on arc elements**: in isoparametric quadratic
  geometry, the normal at `η` is computed from `dx/dη` via the
  shape-function derivatives we already have. There's no need to
  special-case straight vs arc — both flow through the same formula,
  just with different anchor positions. The "compute once, reuse"
  applies uniformly.
- **Singular integrals on the diagonal**: the rigid-body trick
  (`H_ii = -Σ H_ik`) means the diagonal is *derived* from
  off-diagonals, not integrated. So if any off-diagonal in row `i` is
  invalidated, the diagonal must be recomputed for that row — Layer
  B's cache invalidation has to propagate to the corresponding row's
  diagonal. Worth handling explicitly.

## 8. The 80/20 question: is full Layer B cache necessary day-one?

Honestly, no. At the rectangle-with-a-handful-of-elements size we're
testing now, *step 1* (uncached full solve) will run in milliseconds
and feel instantaneous regardless. Build the correct solver first,
ship it, and add Layer A/B caching only when we actually have a
problem large enough that the user notices a stutter. The architectural
prerequisite — keeping the mesh structurally immutable so caching CAN
be added later — is what matters now. Doing that today costs nothing
and lets caching slot in cleanly later.

## 9. Recommended next steps

Pursue in this order:

1. **Correct uncached solver** + Williams-expansion validation.
2. **Ref-preserving `discretiseLines`** (architectural prep, no
   caching yet).
3. **Layer A cache**.
4. Only then **Layer B + C** if needed.
