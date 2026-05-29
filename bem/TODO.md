# TODO

## Continuous-scheme corner behaviour — analysis may be wrong

**Status:** unresolved. The BC-merge fix landed (commit `7369d2f`) and is
correct in isolation (merged nodal DOFs at the corner now reflect the
applied loads instead of being order-dependent). But the convergence
experiment I ran afterward looks worse than it should be for
continuous BEM, and Gareth flagged it:

> continuous corners are fine normally

so my diagnosis below is probably off.

### What I observed

Biaxial tension on the 8×8 plate from `examples/plate no hole.json`
(left dx=0, bottom dy=0, right tx=100 GPa, top ty=100 GPa,
E=207 GPa, ν=0.3, plane stress). Analytical ux on the right edge =
σ(1−ν)L/E = 2.7053 m, uniform.

| Scheme        | N=2     | N=4     | N=8     | N=16    |
|---------------|---------|---------|---------|---------|
| continuous    | 3.27    | 2.96    | 2.82    | 2.76    |
| discontinuous | 2.7018  | 2.7036  | 2.7044  | 2.7049  |

Discontinuous is essentially analytical at every refinement, including
N=2. Continuous is way off at coarse meshes and only crawls toward the
right answer.

### What I claimed in the commit

That this is "the inherent corner-traction-discontinuity error of
continuous scheme without double collocation" — both adjacent edges'
integrations read the same nodal traction, so neither face's true
traction is reproduced near corners. Convergence-wise this should still
work but slowly.

### Why that might be wrong

Continuous elements ARE the default in classical BEM codes (Brebbia,
BEASY etc.) and biaxial tension is the textbook validation case. They
get clean convergence. Mechanisms they use:

- **Double collocation at corners** — two collocation points at the
  same position, one row per face. Each row sees its own face's
  traction. The interpretation of "shared corner node" splits at the
  corner.
- **Multiple-node techniques** — face-resolved traction DOFs at
  corners (shared `u`, split `t`).

If those are needed for clean continuous-scheme convergence, then my
engine's behaviour is *expected* and not a bug — we just don't have
those mechanisms. But it's worth checking I haven't broken something
more basic first.

### Things to check before adding double collocation

1. **Uniaxial tension, continuous scheme.** Run the existing
   uniaxial-6×4 setup (`solve.test.ts:138`) but with the continuous
   override and see if it converges. If THAT is also slow, the bug is
   probably bigger than "corner discontinuity needs double nodes".
2. **The free term c_ij at a corner.** The rigid-body trick
   (`assemble.ts:184`) sets `H_ii = -Σ_{j≠i} H_ij`. That implicitly
   subsumes the c_ij free term — works for smooth boundaries, should
   also work for corners (∫T*dΓ over a closed curve is still −δ_ij
   regardless of corner angles). Worth confirming by computing c_ij
   directly via the interior-angle formula for a 90° corner
   (c = ¼ δ_ij) and checking the diagonal block agrees.
3. **Singular integration over the two corner-adjacent elements.**
   When the collocation point is at a shared corner, BOTH adjacent
   elements need special treatment (each has the singularity at one
   of its endpoints). `integrateOverElement` is called with
   `singularLocalIdx ∈ {0, 1, 2}` — verify that endpoint-singular
   integration is implemented as well as the η=0 (mid-element) case.
   If only the mid-element case is handled correctly, that would
   explain a corner-specific error.
4. **The merge rule itself.** My current rule picks the non-zero
   traction. But maybe at a corner the "physically right" nodal
   traction in continuous-element BEM is the **average** of the two
   face tractions, not the load value. Some BEM books do this. Try
   `(t_top + t_right) / 2` at corners and see if convergence
   improves.
5. **A known reference.** Brebbia & Dominguez §5 has the biaxial-
   plate worked example with continuous elements and a converged
   solution at N=4 per side. Compare matrix entries directly if we
   can find a tabulated case.

### Next concrete step

Re-run the convergence sweep but for **uniaxial** tension with
continuous scheme. If it converges cleanly, the slow-convergence is
biaxial-specific (corner traction discontinuity) and the fix is real
(double collocation / face-split tractions). If it's also slow, there's
an unrelated bug in the kernel / assembly / singular integration that
I need to find first.
