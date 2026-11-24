/** Backend-neutral identity of one grantable operation. */
export interface OperationShape {
  profile: string; token_id: string; tool: string; verb_path: string;
  resource_kind: string; namespace: string; object_count_max: number; flags_allowed: readonly string[];
}
export function baseShapeKey(shape: Pick<OperationShape, 'profile' | 'token_id' | 'tool' | 'verb_path' | 'resource_kind' | 'namespace'>): string {
  return JSON.stringify([shape.profile,shape.token_id,shape.tool,shape.verb_path,shape.resource_kind,shape.namespace]);
}
