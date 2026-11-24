import type { CallerIdentity } from '../../../common/request/context.js';
import type { OperationShape } from './kubectl.js';

/** Shape functions for one tool, as the standing-grant machinery consumes them. */
export interface ToolShapes {
  /** Strict shape a standing grant may be claimed against; null means "needs consent". */
  shape(argv: readonly string[], verb: string, caller: CallerIdentity): OperationShape | null;
  /** Looser shape used to record rejections; it can only deny, never authorize. */
  baseShape(argv: readonly string[], verb: string, caller: CallerIdentity): OperationShape | null;
}

/** Tool name (as configured in YAML) to its shape functions. */
export interface ShapeRegistry {
  shapesFor(tool: string): ToolShapes | undefined;
}

export function createShapeRegistry(entries: Readonly<Record<string, ToolShapes>>): ShapeRegistry {
  const byTool = new Map(Object.entries(entries));
  return { shapesFor: tool => byTool.get(tool) };
}

/** No tool has a shape: standing grants never apply. */
export const NO_SHAPES: ShapeRegistry = createShapeRegistry({});
