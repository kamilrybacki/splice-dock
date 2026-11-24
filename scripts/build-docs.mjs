import {readFileSync,writeFileSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {makePages,escape} from '../docs/web/pages.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(join(root,'docs/web/config.json'),'utf8'));
const pages=makePages(config,readFileSync(join(root,'docs/web/examples/quickstart.yaml'),'utf8').trim());
const out=join(root,'_site');
// Only generated output is replaced; content and application files stay untouched.
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
cpSync(join(root,'docs/web/assets'),join(out,'assets'),{recursive:true});
cpSync(join(root,'docs/web/examples'),join(out,'examples'),{recursive:true});
for(const file of ['style.css','client.js'])cpSync(join(root,'docs/web',file),join(out,file));
const text=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const nav=current=>`<nav aria-label="Documentation">${pages.map((p,i)=>`<a href="${p.slug}.html" ${current===p.slug?'aria-current="page"':''}><span>${String(i).padStart(2,'0')}</span>${escape(p.nav)}</a>`).join('')}</nav>`;
for(const [i,page] of pages.entries()){
 const toc=[...page.body.matchAll(/<section id="([^"]+)"[^>]*><h2><a[^>]*>(.*?)<\/a><\/h2>/g)].map(([,id,title])=>({id,title:text(title)}));
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escape(page.description)}"><meta name="theme-color" content="#f2f2f2"><title>${escape(page.title)} · documentation ${escape(config.name)}</title><link rel="canonical" href="${config.siteUrl}${page.slug==='index'?'':page.slug+'.html'}"><link rel="icon" type="image/svg+xml" href="assets/splicedock-mark.svg"><link rel="stylesheet" href="style.css"><script src="client.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a><header class="topbar"><a class="brand" href="index.html"><img src="assets/splicedock-mark.svg" width="30" height="30" alt="">${escape(config.name)}</a><span class="site-label">USER DOCUMENTATION</span><a class="repo" href="${config.repository}">GitHub <span aria-hidden="true">[ ↗ ]</span></a></header><div class="docs-shell"><aside class="sidebar"><p class="prompt">~/docs $ <i></i></p><div class="search"><label for="docs-search">Search the documentation</label><input id="docs-search" type="search" autocomplete="off" placeholder="e.g. token, YAML, timeout"><div id="search-results" class="search-results" hidden aria-live="polite"></div></div>${nav(page.slug)}<p class="sidebar-note">MCP · profile · policy<br>Code Mode · observability</p></aside><details class="mobile-menu"><summary>Contents</summary>${nav(page.slug)}</details><main id="main"><div class="page-kicker">${escape(page.kicker)}</div><div class="page-heading ${page.art?'with-art':''}"><h1>${escape(page.heading)}</h1>${page.art?`<img class="heading-art" src="assets/${page.art}" alt="">`:''}</div><p class="page-description">${escape(page.description)}</p>${toc.length?`<details class="page-toc"><summary>On this page</summary><ul>${toc.map(x=>`<li><a href="#${x.id}">${escape(x.title)}</a></li>`).join('')}</ul></details>`:''}<article>${page.body}</article><nav class="page-turn" aria-label="Previous and next page">${i?`<a href="${pages[i-1].slug}.html"><span>PREVIOUS</span>${escape(pages[i-1].nav)}</a>`:'<span></span>'}${i<pages.length-1?`<a href="${pages[i+1].slug}.html"><span>NEXT</span>${escape(pages[i+1].nav)}</a>`:''}</nav><footer><div class="progress" aria-hidden="true"><i style="width:${(i+1)/pages.length*100}%"></i></div><a href="${config.authorUrl}">${escape(config.authorUrl.replace('https://',''))}</a><span>${escape(config.name)} / ${escape(page.nav)}</span></footer></main></div></body></html>`;
 writeFileSync(join(out,page.slug+'.html'),html);
}
writeFileSync(join(out,'search-index.json'),JSON.stringify(pages.map(p=>({title:p.title,url:p.slug+'.html',description:p.description,text:text(p.body)}))));
writeFileSync(join(out,'404.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/svg+xml" href="${config.siteUrl}assets/splicedock-mark.svg"><link rel="stylesheet" href="${config.siteUrl}style.css"><title>Page not found</title><main class="not-found"><div class="page-kicker">404 / NOT FOUND</div><h1>This documentation page does not exist.</h1><p><a href="${config.siteUrl}">Return to ${escape(config.name)}</a></p></main></html>`);
writeFileSync(join(out,'.nojekyll'),'');
writeFileSync(join(out,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}sitemap.xml\n`);
writeFileSync(join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p=>`<url><loc>${config.siteUrl}${p.slug==='index'?'':p.slug+'.html'}</loc></url>`).join('')}</urlset>`);
console.log(`Built ${pages.length} documentation pages in _site (public content only).`);
