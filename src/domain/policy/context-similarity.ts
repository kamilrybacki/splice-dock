const STOP = new Set('a an the and or to of in on for with is are this that it after before from'.split(' '));
function tokens(text:string):string[] {
  return text.toLowerCase().replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g,' identifier ').replace(/\b(?:0x[0-9a-f]+|[0-9a-f]{8,}|\d+)\b/g,' identifier ').match(/[a-z]+/g)?.filter(t=>!STOP.has(t)) ?? [];
}
/** Pairwise TF-IDF over the stored reference corpus plus the candidate. No egress. */
export function contextSimilarity(candidate:string, reference:string, corpus:readonly string[]=[reference]):number {
  const documents=[...corpus,candidate].map(tokens), a=tokens(candidate), b=tokens(reference);
  if(!a.length || !b.length)return 0;
  const terms=new Set([...a,...b]);let dot=0,aa=0,bb=0;
  for(const t of terms){const idf=1+Math.log((documents.length+1)/(1+documents.filter(d=>d.includes(t)).length));const x=a.filter(v=>v===t).length*idf,y=b.filter(v=>v===t).length*idf;dot+=x*y;aa+=x*x;bb+=y*y;}
  return Math.min(1,dot/Math.sqrt(aa*bb));
}
