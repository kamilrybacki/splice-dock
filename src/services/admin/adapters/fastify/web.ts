import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderProfilesPage } from './web/pages/profiles.js';
import { renderAutomaticApprovals } from './web/pages/approvals/automatic.js';
// Admin WebUI — routing wiring only. HTML generation lives in ./web/* modules.
// Routes: GET/POST /admin/login, POST /admin/logout, GET /admin/,
//         GET /admin/tools/:name, GET /admin/audit,
//         GET /admin/approvals[/:id], GET /admin/metrics, GET /admin/swipe
// PWA (no session, no user data): GET /admin/manifest.webmanifest,
//         GET /admin/sw.js, GET /admin/icon-<size>.png

import type { FastifyInstance } from 'fastify';
import { buildSessionCtx, verifyBypassSecret, setSessionCookie, clearSessionCookie, requireSession } from './web/session.js';
import { AUTHELIA_HEADER, CSRF_HEADER } from './auth.js';
import { renderPage } from './web/layout.js';
import { renderLoginPage } from './web/pages/login.js';
import { renderToolsPage } from './web/pages/tools.js';
import { renderToolDetail } from './web/pages/tools/detail/index.js';
import { renderAuditPage, parseDecisionFilter } from './web/pages/audit.js';
import { renderApprovalsPage, renderApprovalDetail } from './web/pages/approvals.js';
import { renderMetricsPage } from './web/pages/metrics.js';
import { renderSwipePage } from './web/pages/swipe.js';
import { MANIFEST, SERVICE_WORKER, ICON_SIZES, renderIconPng } from './web/pwa.js';
import type { WebUiOptions } from './web/types.js';

export function registerWebUiRoutes(app: FastifyInstance, opts: WebUiOptions): void {
  const authCtx = buildSessionCtx(opts);
  let editorBundle: Promise<string> | undefined;
  app.get('/admin/profiles', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    return reply.type('text/html').send(renderPage({ title: 'Profiles', navKey: 'profiles', body: renderProfilesPage() }));
  });
  app.get('/admin/profiles-editor.js', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    editorBundle ??= build({ entryPoints: [fileURLToPath(new URL('./web/profiles/editor/main.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'), import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife', minify: true }).then(result => result.outputFiles[0].text).catch(error => { editorBundle = undefined; throw error; });
    return reply.type('application/javascript').send(await editorBundle);
  });

  app.get('/admin/login', async (req, reply) => {
    if (opts.autheliaBypassSecret) {
      const bypass = req.headers[AUTHELIA_HEADER];
      if (typeof bypass === 'string' && verifyBypassSecret(bypass, opts.autheliaBypassSecret)) {
        setSessionCookie(reply, opts.expectedToken);
        reply.redirect('/admin/');
        return;
      }
    }
    reply.type('text/html').send(renderLoginPage());
  });

  // Tight per-IP throttle on the credential endpoint. The app-level
  // @fastify/rate-limit cap (120/min) is too permissive for password guessing.
  // If @fastify/rate-limit is not registered, this config object is silently
  // ignored — the global limit still applies as a fallback.
  app.post<{ Body: { token?: string } }>('/admin/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const submitted = (req.body && typeof req.body.token === 'string') ? req.body.token : '';
    if (!authCtx.tokens.identify(submitted)) {
      reply.type('text/html').code(401).send(renderLoginPage({ error: true }));
      return;
    }
    setSessionCookie(reply, submitted);
    reply.redirect('/admin/');
  });

  app.post('/admin/logout', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    if (!req.headers[CSRF_HEADER]) {
      reply.code(403).send({ error: { code: 'csrf', message: 'Missing CSRF header' } });
      return;
    }
    clearSessionCookie(reply);
    reply.redirect('/admin/login');
  });

  app.get('/admin/', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    const { policies, recent_denies, metrics } = await opts.snapshot();
    let pending_approvals_count = 0;
    if (opts.approvalsList) {
      try { pending_approvals_count = (await opts.approvalsList('pending')).length; } catch { /* degraded */ }
    }
    reply.type('text/html').send(renderPage({ title: 'Tools', navKey: 'tools', body: renderToolsPage({ policies, recent_denies, metrics, pending_approvals_count }) }));
  });

  app.get<{ Params: { name: string }; Querystring: { profile?: string } }>('/admin/tools/:name', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    const d = await opts.detail(req.params.name, req.query.profile || undefined);
    if (!d) { reply.code(404).type('text/html').send(renderPage({ title: '404', navKey: 'tools', body: '<h2>tool not found</h2>' })); return; }
    reply.type('text/html').send(renderPage({ title: d.view.tool as string, navKey: 'tools', body: renderToolDetail({ tool: req.params.name, view: d.view, profiles: d.profiles, profile: d.profile, profile_override: d.profile_override, metric: d.metric, recent: d.recent }) }));
  });

  app.get<{ Querystring: { decision?: string } }>('/admin/audit', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    const entries = await opts.auditList(200);
    const tools = Array.from(new Set(entries.map((e) => e.tool)));
    reply.type('text/html').send(renderPage({ title: 'Audit', navKey: 'audit', body: renderAuditPage({ entries, tools, initialDecision: parseDecisionFilter(req.query.decision) }) }));
  });

  app.get<{ Querystring: { status?: string } }>('/admin/approvals', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    if (!opts.approvalsList) { reply.code(503).type('text/html').send(renderPage({ title: 'Approvals', navKey: 'approvals', body: '<h2>approvals not enabled</h2><p class="muted">No approval service is wired in this splicedock instance.</p>' })); return; }
    const activeTab = (req.query.status && ['pending','approved','rejected','expired','reserved','consumed','failed','all','grant','automatic'].includes(req.query.status)) ? req.query.status : 'pending';
    if(activeTab==='automatic')return reply.type('text/html').send(renderPage({title:'Automatic approvals',navKey:'approvals',body:renderAutomaticApprovals()}));
    const rows = await opts.approvalsList(activeTab === 'all' ? undefined : activeTab);
    reply.type('text/html').send(renderPage({ title: 'Approvals', navKey: 'approvals', body: renderApprovalsPage({ rows, activeTab }) }));
  });

  app.get<{ Params: { id: string } }>('/admin/approvals/:id', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    if (!opts.approvalDetail) { reply.code(503).type('text/html').send(renderPage({ title: 'Approval', navKey: 'approvals', body: '<h2>approvals not enabled</h2>' })); return; }
    const row = await opts.approvalDetail(req.params.id);
    if (!row) { reply.code(404).type('text/html').send(renderPage({ title: 'Approval', navKey: 'approvals', body: '<h2>approval not found</h2>' })); return; }
    reply.type('text/html').send(renderPage({ title: `Approval ${row.id}`, navKey: 'approvals', body: renderApprovalDetail({ row }) }));
  });

  app.get('/admin/swipe', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    reply.type('text/html').send(renderPage({ title: 'Swipe', navKey: 'swipe', body: renderSwipePage() }));
  });

  const brandAssets = {
    'splicedock-mark.svg': 'image/svg+xml',
    'space-grotesk-latin-500.woff2': 'font/woff2',
    'space-grotesk-latin-700.woff2': 'font/woff2',
    'space-mono-latin-400.woff2': 'font/woff2',
    'space-mono-latin-700.woff2': 'font/woff2',
  };
  for (const [file, type] of Object.entries(brandAssets)) {
    const path = new URL('../../../../../docs/web/assets/' + file, import.meta.url);
    let asset: Promise<Buffer> | undefined;
    app.get('/admin/brand/' + file, async (_req, reply) => {
      asset ??= readFile(path).catch((error) => { asset = undefined; throw error; });
      return reply.type(type).header('Cache-Control', 'public, max-age=86400').send(await asset);
    });
  }

  const manifestJson = JSON.stringify(MANIFEST);
  app.get('/admin/manifest.webmanifest', async (_req, reply) => {
    reply.type('application/manifest+json').send(manifestJson);
  });

  app.get('/admin/sw.js', async (_req, reply) => {
    reply.type('application/javascript').header('Cache-Control', 'no-cache').header('Service-Worker-Allowed', '/admin/').send(SERVICE_WORKER);
  });

  const icons = new Map<number, Buffer>();
  app.get<{ Params: { file: string } }>('/admin/:file', async (req, reply) => {
    const m = /^icon-(\d+)\.png$/.exec(req.params.file);
    const size = m ? Number(m[1]) : NaN;
    if (!ICON_SIZES.includes(size)) { reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }); return; }
    let png = icons.get(size);
    if (!png) { png = renderIconPng(size); icons.set(size, png); }
    reply.type('image/png').header('Cache-Control', 'public, max-age=86400').send(png);
  });

  app.get('/admin/metrics', async (req, reply) => {
    if (!requireSession(req, reply, authCtx)) return;
    const raw = await opts.metricsList();
    const metrics = raw.map((m) => ({ ...m, last_ts: m.last_ts ?? 0 }));
    const hourly = opts.metricsHourly?.() ?? null;
    reply.type('text/html').send(renderPage({ title: 'Metrics', navKey: 'metrics', body: renderMetricsPage({ metrics, ...(hourly ? { hourly } : {}) }) }));
  });
}
