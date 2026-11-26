/** A tool (optionally narrowed to one verb path) that is never covered by a standing grant. */
export interface GrantException {tool:string;verb_path?:string;}

/** Exceptions no configuration or operator action can remove: a standing grant
 *  never covers these, regardless of grant_exceptions. Empty today; strong
 *  (WebAuthn) tools are excluded separately, see BUILT_IN_GRANT_EXCEPTION_LABELS. */
export const BUILT_IN_GRANT_EXCEPTIONS:readonly Required<GrantException>[]=[];

export function isBuiltInGrantException(tool:string,verb:string):boolean {
  return BUILT_IN_GRANT_EXCEPTIONS.some(e=>e.tool===tool && (e.verb_path==='*' || e.verb_path===verb));
}

/** Human-readable labels for the built-in exceptions (admin API and UI). */
export const BUILT_IN_GRANT_EXCEPTION_LABELS:readonly string[]=['requireStrong/WebAuthn',...BUILT_IN_GRANT_EXCEPTIONS.map(e=>`${e.tool} ${e.verb_path}`)];
/** ADR 0009: executed same-shape approvals needed before a grant is learned. */
export const DEFAULT_GRANT_THRESHOLD=3;
/** SPLICEDOCK_GRANT_CONTEXT_MIN_SIM is ignored since ADR 0009: context never widens a match. */
export function readGrantConfig(env:NodeJS.ProcessEnv):{threshold:number;exceptions:GrantException[]|undefined} {
  if(env.SPLICEDOCK_GRANTS!=='1')return {threshold:DEFAULT_GRANT_THRESHOLD,exceptions:undefined};
  const threshold=Number(env.SPLICEDOCK_GRANT_THRESHOLD ?? DEFAULT_GRANT_THRESHOLD);
  if(!Number.isInteger(threshold) || threshold<1)throw new Error('invalid standing grant thresholds');
  const exceptions:unknown=JSON.parse(env.SPLICEDOCK_GRANT_EXCEPTIONS ?? '[]');
  if(!Array.isArray(exceptions) || exceptions.some(e=>!e || typeof e.tool!=='string' || !e.tool || (e.verb_path!==undefined && (typeof e.verb_path!=='string' || !e.verb_path))))throw new Error('invalid standing grant exceptions');
  return {threshold,exceptions:env.SPLICEDOCK_GRANT_EXCEPTIONS===undefined?undefined:exceptions};
}
