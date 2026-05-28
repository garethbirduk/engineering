# bem

DBE-SBFEM port — interactive 2D BEM/SBFEM for linear elastic fracture mechanics, reimplemented from Bird's 2012 Durham thesis. TypeScript end-to-end, web frontend, no backend.

See [`../thesis/PORT.md`](../thesis/PORT.md) for the design.

## Layout

```
bem/
├── engine/      @bem/engine    — pure TS library: maths, kernels, assembly, solver
├── webapp/      @bem/webapp    — Vite + React 18, plotly viewer + CAD editor
└── headless/    @bem/headless  — tsx CLI for batch / convergence runs
```

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
