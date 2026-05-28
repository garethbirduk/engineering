# todo

CAD editor build order. Steps 1–5 are geometry; 6–9 are mesh-building.

1. [x] SVG canvas with pan/zoom
2. [ ] Point tool + snap-to-grid
3. [ ] Line tool (click P₁ click P₂)
4. [ ] Select + drag a point (attached lines follow)
5. [ ] Convert-to-arc + SVG arc rendering
6. [ ] Multi-select + closed-loop detection + "Create boundary" button
7. [ ] Boundary list panel + domain creation
8. [ ] Per-line properties panel (BCs, nElements, nodal positions)
9. [ ] Export → engine JSON; import MATLAB 4-file format

See [thesis/PORT.md](thesis/PORT.md) for the design context.
