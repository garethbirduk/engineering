export * from "./solve.js";
export * from "./interiorEval.js";
export * from "./interiorStressEval.js";
export * from "./boundaryStress.js";
export {
  createBlockCache,
  type AssembleStats,
  type BlockCache,
} from "./assemble.js";
export {
  integrateOverElement,
  traceCellIntegrand,
  type Block2x6,
  type CellSelector,
  type ElementBlocks,
  type IntegrandTrace,
} from "./elementIntegration.js";
export {
  traceBoundaryKernels,
  type BoundaryKernelTraces,
  type BoundaryWalk,
  type ElementOnBoundary,
  type KernelSample,
} from "./boundaryKernelTrace.js";
export type { StressTriple } from "./stressKernels.js";
