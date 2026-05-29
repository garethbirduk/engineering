// Fill in the displacement at every post-mesh node by Somigliana
// evaluation against the solved boundary mesh.
//
// Returns the same node array shape with one Vec2 per node — caller
// reads u_x or u_y or |u| as needed for the colour mapping.

import type { MeshElement } from "../elements/discretise.js";
import type { Vec2 } from "../geometry/types.js";
import { interiorDisplacement } from "../analysis/interiorEval.js";
import type { MaterialProperties } from "../analysis/kernels.js";
import type { PostMesh } from "./triangulate.js";

export interface PostFieldValues {
  /** One Vec2 per post-mesh node, in the same order as PostMesh.nodes. */
  readonly u: readonly Vec2[];
}

export function evaluatePostField(
  postMesh: PostMesh,
  solvedBoundary: readonly MeshElement[],
  material: MaterialProperties,
): PostFieldValues {
  const u: Vec2[] = new Array(postMesh.nodes.length);
  for (let i = 0; i < postMesh.nodes.length; i++) {
    u[i] = interiorDisplacement(postMesh.nodes[i]!, solvedBoundary, material);
  }
  return { u };
}
