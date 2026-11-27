import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'_site');
const pages=readdirSync(output).filter(file=>file.endsWith('.html'));
let count=0;
for(const page of pages){
 const html=readFileSync(join(output,page),'utf8');
 assert.match(html,/<html lang="en">/,page+' language');
 assert.match(html,/<title>[^<]+<\/title>/,page+' title');
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(ids.length,new Set(ids).size,page+' duplicate ids');
 for(const [,link] of html.matchAll(/(?:href|src)="([^"]+)"/g)){
  if(/^(?:https?:|data:|mailto:)/.test(link))continue;
  const [path,anchor]=link.split('#');
  const target=resolve(output,path||page);assert.ok(target.startsWith(output+'/'),link+' outside output');
  assert.ok(existsSync(target),page+' broken link '+link);
  if(anchor&&extname(target)==='.html')assert.ok(readFileSync(target,'utf8').includes(`id="${anchor}"`),page+' broken anchor '+link);
  count++;
 }
 assert.doesNotMatch(html,/(?:10\.42\.\d+\.\d+|192\.168\.\d+\.\d+|secret\/homelab|splicedock\.svc\.cluster\.local|sha256:[0-9a-f]{64})/,page+' private infrastructure reference');
}
const index=JSON.parse(readFileSync(join(output,'search-index.json'),'utf8'));assert.equal(index.length,11);assert.ok(index.some(p=>p.url==='code-mode.html'));assert.ok(index.every(p=>p.text.length>100));
console.log(`PASS: ${pages.length} HTML files, ${count} local links/assets, search index and public-content scan.`);
