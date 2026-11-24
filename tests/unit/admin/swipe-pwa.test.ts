import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { inflateSync } from 'node:zlib';
import { ADMIN_SESSION_COOKIE } from '../../../src/services/admin/adapters/fastify/auth.js';
import { registerWebUiRoutes } from '../../../src/services/admin/adapters/fastify/web.js';
import { renderSwipePage } from '../../../src/services/admin/adapters/fastify/web/pages/swipe.js';
import { renderIconPng } from '../../../src/services/admin/adapters/fastify/web/pwa.js';
import type { WebUiOptions } from '../../../src/services/admin/adapters/fastify/web/types.js';

const TOKEN = 'swipe-test-placeholder';
const cookie = `${ADMIN_SESSION_COOKIE}=${TOKEN}`;
let app: ReturnType<typeof Fastify> | undefined;

async function build() {
  app = Fastify({ logger: false });
  const opts = {
    expectedToken: TOKEN,
    snapshot: async () => ({ policies: [], recent_denies: [], metrics: [] }),
    detail: async () => null,
    auditList: async () => [],
    metricsList: async () => [],
    approvalsList: async () => [],
    approvalDetail: async () => null,
  } as unknown as WebUiOptions;
  registerWebUiRoutes(app, opts);
  await app.ready();
  return app;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('swipe page', () => {
  it('redirects to login without a session', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/admin/swipe' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/admin/login');
  });

  it('renders the deck and the manifest link with a session', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/admin/swipe', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('id="swipe-deck"');
    expect(r.body).toContain('<link rel="manifest" href="/admin/manifest.webmanifest" crossorigin="use-credentials"');
    expect(r.body).toContain('href="/admin/swipe"');
  });

  it('client script never writes user data through innerHTML and encodes the id', () => {
    const body = renderSwipePage();
    expect(body).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(body).toContain("encodeURIComponent(");
    expect(body).toContain('/api/v1/approvals?status=pending');
    expect(body).toContain('webauthn_required');
  });

  it('offers a push opt-in that subscribes with the CSRF header', () => {
    const body = renderSwipePage();
    expect(body).toContain("'PushManager' in window");
    expect(body).toContain('/api/v1/push/vapid-public-key');
    expect(body).toContain('(await res.json()).publicKey');
    expect(body).toContain('Notification.requestPermission()');
    expect(body).toContain('userVisibleOnly: true');
    expect(body).toContain('/api/v1/push/subscribe');
    expect(body).toContain("'x-splicedock-csrf': '1'");
  });

  it('pointercancel resets the card and never commits a decision', () => {
    const body = renderSwipePage();
    expect(body).toContain("addEventListener('pointercancel', function () { end(false); })");
    expect(body).toContain("addEventListener('pointerup', function () { end(true); })");
  });

  it('background re-renders skip active drags and compare against the 3-card cap', () => {
    const body = renderSwipePage();
    expect(body).toContain('Math.min(3, visible().length)');
    expect(body).toMatch(/!busy && !dragging/);
  });

  it('drops poll results that started before the last decision', () => {
    expect(renderSwipePage()).toContain('if (decidedAt >= started || busy) return;');
  });

  it('keyboard shortcuts ignore modifiers, repeats and form fields', () => {
    const body = renderSwipePage();
    expect(body).toContain('e.altKey || e.ctrlKey || e.metaKey || e.repeat');
    expect(body).toContain('isContentEditable');
  });

  it('pads for notch and home-indicator safe areas', () => {
    expect(renderSwipePage()).toMatch(/env\(safe-area-inset-bottom\)[\s\S]*env\(safe-area-inset-bottom\)/);
  });
});

describe('pwa assets', () => {
  it('serves an installable manifest scoped to /admin/', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/admin/manifest.webmanifest' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/manifest\+json/);
    const m = r.json();
    expect(m.start_url).toBe('/admin/swipe');
    expect(m.scope).toBe('/admin/');
    expect(m.display).toBe('standalone');
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });

  it('serves a network-only service worker that is never cached', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/admin/sw.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.body).toContain("addEventListener('fetch'");
    expect(r.body).not.toMatch(/caches\.open/);
  });

  it('service worker always shows a generic notification on push and opens the swipe deck on click', async () => {
    const a = await build();
    const body = (await a.inject({ method: 'GET', url: '/admin/sw.js' })).body;
    expect(body).toContain("addEventListener('push'");
    expect(body).toContain('e.waitUntil(self.registration.showNotification(');
    expect(body).toContain("tag: 'splicedock-approval'");
    expect(body).toContain('renotify: true');
    expect(body).toContain("addEventListener('notificationclick'");
    expect(body).toContain("clients.matchAll({ type: 'window', includeUncontrolled: true })");
    expect(body).toContain('clients.openWindow(SWIPE_URL)');
    expect(body).toContain("var SWIPE_URL = '/admin/swipe';");
  });

  it.each([192, 512, 180])('serves a valid %ipx PNG icon', async (size) => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: `/admin/icon-${size}.png` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    const buf = r.rawPayload;
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(buf.readUInt32BE(16)).toBe(size);
    expect(buf.readUInt32BE(20)).toBe(size);
  });

  it('404s unknown icon sizes', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/admin/icon-77.png' });
    expect(r.statusCode).toBe(404);
  });

  it('icon pixel data decodes to size rows of RGBA', () => {
    const png = renderIconPng(48);
    const idat = png.indexOf('IDAT');
    const len = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
    expect(raw.length).toBe(48 * (1 + 48 * 4));
  });
});
