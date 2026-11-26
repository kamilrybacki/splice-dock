/** ADR 0010: shortest whole-segment prefix a grant may rest on, before its trailing separator. */
export const MIN_NAME_PREFIX_BODY=3;
/**
 * Longest common prefix of all object names, cut just after its last `-` or `.`
 * so only whole name segments remain (`backup-29384701`, `backup-29384702` -> `backup-`).
 * Returns null when no separator survives or fewer than three characters precede it:
 * such a prefix would not narrow the grant, so no grant forms.
 */
export function grantNamePrefix(names:readonly string[]):string|null {
  if(!names.length)return null;
  let common=names[0];
  for(const name of names){let i=0;while(i<common.length && i<name.length && common[i]===name[i])i++;common=common.slice(0,i);}
  const cut=Math.max(common.lastIndexOf('-'),common.lastIndexOf('.'));
  if(cut<MIN_NAME_PREFIX_BODY)return null;
  return common.slice(0,cut+1);
}
