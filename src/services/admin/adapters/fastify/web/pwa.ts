// PWA assets for the admin WebUI: web app manifest, a network-only service
// worker and app icons. The icons are rasterised here (no image deps) so the
// "Add to home screen" flow works on both Android (manifest icons) and iOS
// (apple-touch-icon, which must be PNG).
//
// None of these assets carry user data, so they are served without a session:
// browsers fetch the manifest/icons without app cookies in several contexts.
// The edge (Authelia) still guards the whole host.

import { deflateSync } from 'node:zlib';

export const ICON_SIZES: ReadonlyArray<number> = [180, 192, 512];

export const THEME_COLOR = '#0d0d0d';

export const MANIFEST = {
  name: 'Splicedock approvals',
  short_name: 'Approvals',
  description: 'Swipe right to approve, left to reject.',
  id: '/admin/swipe',
  start_url: '/admin/swipe',
  scope: '/admin/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  icons: [192, 512].map((s) => ({ src: `/admin/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })),
} as const;

// Network-only: approvals are live state, a cached response would show stale
// cards. The worker makes the app installable and shows Web Push alerts.
// Every push MUST show a notification (browsers revoke silent-push senders),
// so a bad payload falls back to a generic title. The click target is fixed
// here, never taken from the payload.
export const SERVICE_WORKER = `var SWIPE_URL = '/admin/swipe';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) { e.respondWith(fetch(e.request)); });
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }
  var title = typeof data.title === 'string' && data.title ? data.title : 'Approval needed';
  var body = typeof data.body === 'string' ? data.body : '';
  e.waitUntil(self.registration.showNotification(title, {
    body: body, tag: 'splicedock-approval', renotify: true,
    icon: '/admin/icon-192.png', badge: '/admin/icon-192.png'
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (new URL(list[i].url).pathname === SWIPE_URL && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(SWIPE_URL);
  }));
});
`;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Distance from point p to segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

type Rgb = readonly [number, number, number];
const BG: Rgb = [0x0d, 0x0d, 0x0d];
const GREEN: Rgb = [0xc9, 0xd9, 0x9a];

/** Pixel colour in unit coordinates: dark tile, green check inside the maskable safe zone. */
function pixel(x: number, y: number): Rgb {
  const stroke = 0.075;
  const d = Math.min(segDist(x, y, 0.3, 0.52, 0.44, 0.66), segDist(x, y, 0.44, 0.66, 0.72, 0.36));
  return d <= stroke ? GREEN : BG;
}

/** Render a square RGBA PNG icon of the given size. */
export function renderIconPng(size: number): Buffer {
  const row = 1 + size * 4;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
