// Shared page chrome and design tokens for the Splicedock admin UI.

import { escapeHtml } from './components.js';
import { SHARED_SCRIPTS } from './scripts.js';
import { DIALOG_SCRIPT, DIALOG_STYLES } from './dialog-assets.js';
import { THEME_COLOR } from './pwa.js';

const MARK = '<img src="/admin/brand/splicedock-mark.svg" width="36" height="36" alt="">';
export const BRAND = `<span class="brand-identity">${MARK}<span>Splicedock</span></span>`;

const STYLES = `
@font-face { font-family: 'Space Grotesk'; src: url('/admin/brand/space-grotesk-latin-500.woff2') format('woff2'); font-weight: 500; font-display: swap; }
@font-face { font-family: 'Space Grotesk'; src: url('/admin/brand/space-grotesk-latin-700.woff2') format('woff2'); font-weight: 700; font-display: swap; }
@font-face { font-family: 'Space Mono'; src: url('/admin/brand/space-mono-latin-400.woff2') format('woff2'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Space Mono'; src: url('/admin/brand/space-mono-latin-700.woff2') format('woff2'); font-weight: 700; font-display: swap; }

:root {
  color-scheme: dark;
  --bg: ${THEME_COLOR};
  --surface: #171717;
  --surface-2: #202020;
  --border: #383832;
  --border-strong: #68685b;
  --fg: #f2f2f2;
  --fg-muted: #bcbcb3;
  --fg-faint: #a0a094;
  --accent: #c9d99a;
  --accent-soft: #2b331f;
  --success: #6cc46c;
  --warn: #facc15;
  --danger: #f87171;
  --info: #a78bfa;
  --font: 'Space Mono', ui-monospace, Menlo, monospace;
  --sans: 'Space Grotesk', system-ui, sans-serif;
  --fz: 14px;
  --fz-sm: 12px;
  --fz-lg: 16px;
  --line: 1.5;
  --gap: 0.75rem;
  --gap-sm: 0.5rem;
  --radius: 0;
}

* { box-sizing: border-box; }

html, body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  margin: 0;
}

body {
  font-size: var(--fz);
  line-height: var(--line);
  padding: 0;
}

h1, h2, h3, h4 {
  font-family: var(--sans);
  font-weight: 700;
  margin: 1rem 0 0.5rem;
  letter-spacing: 0;
}
h1 { font-size: clamp(1.9rem, 4vw, 2.55rem); line-height: 1.15; letter-spacing: -.035em; }
h2 { font-size: 1.3rem; }
h3 { font-size: 1.1rem; }
h4 { font-size: 1rem; }

p { margin: 0.5rem 0; }

a {
  color: var(--accent);
  text-decoration: none;
}
a:hover { text-decoration: underline; }

hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1rem 0;
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg);
  border-bottom: 1px solid var(--border-strong);
}
.site-header nav {
  display: flex;
  gap: .9rem;
  align-items: center;
  max-width: 1280px;
  margin: auto;
  padding: .65rem 1.5rem;
  white-space: nowrap;
  font: 400 var(--fz-sm)/1.5 var(--font);
}
.site-header nav > * { flex: none; }
.nav-links { display: flex; align-items: center; gap: .2rem; }
.brand-identity { display: inline-flex; gap: .5rem; align-items: center; font: 700 1.35rem/1 var(--sans); letter-spacing: -.045em; }
.brand-identity img { display: block; border: 1px solid var(--border-strong); }
.site-header nav .brand { color: var(--fg); margin-right: .35rem; padding: 0; }
.site-header nav a { color: var(--fg-muted); padding: .45rem .55rem; }
.site-header nav a:hover { color: var(--fg); text-decoration: none; }
.site-header nav a.active { background: var(--accent); color: var(--bg); font-weight: 700; }
.site-header nav .logout-form { margin-left: auto; }

.skip-link { position: fixed; z-index: 20; left: 1rem; top: -6rem; background: var(--accent); color: var(--bg); padding: .5rem .75rem; }
.skip-link:focus { top: .75rem; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.login-page {
  display: grid;
  place-items: center;
  min-height: 100svh;
  max-width: none;
  background: radial-gradient(#292923 1px, transparent 1px) 0 0 / 18px 18px;
}
.login-panel { width: min(calc(100vw - 2rem), 28rem); }
.login-panel .card {
  border-top: 2px solid var(--accent);
  clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 0 100%);
}
.login-panel .card-body { padding: clamp(1rem, 5vw, 2rem); }
.login-panel h1 { margin-block: 1.25rem .8rem; }
.login-panel .brand-identity { font-size: 1.6rem; }
.login-panel .field { margin-block: 1.1rem; }
.login-panel button { min-height: 42px; }
.login-panel .muted { overflow-wrap: anywhere; }

@media (max-width: 680px) {
  .site-header nav { display: grid; grid-template-columns: 1fr auto; gap: .35rem; padding-inline: .85rem; }
  .site-header nav a { padding-inline: .3rem; }
  .nav-links { grid-row: 2; grid-column: 1 / -1; flex-wrap: wrap; gap: .1rem; }
  .site-header nav .brand { grid-row: 1; justify-self: start; }
  .site-header nav .logout-form { grid-row: 1; grid-column: 2; }
}

main {
  max-width: 1200px;
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 1.8rem);
}

pre, code {
  font-family: var(--font);
  background: var(--surface-2);
}
pre {
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--fz-sm);
  overflow-x: auto;
}
code { padding: 0.05rem 0.3rem; border-radius: var(--radius); }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fz-sm);
}
th, td {
  text-align: left;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  /* long argv / ids must wrap, not widen the page on phones */
  overflow-wrap: anywhere;
}
th { font-weight: 700; color: var(--fg-muted); }
tr:hover td { background: var(--surface); }

input, textarea, select, button {
  font: 400 var(--fz)/var(--line) var(--sans);
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.4rem 0.6rem;
}
input:focus, textarea:focus, select:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-color: var(--accent);
}
textarea { width: 100%; resize: vertical; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .65; }
button:hover { border-color: var(--border-strong); }
button.primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 700;
}
button.primary:hover { filter: brightness(1.1); }
button.danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}
button.danger:hover { background: rgba(248, 113, 113, 0.1); }
button.ghost {
  background: transparent;
  border: none;
  color: var(--fg-muted);
  padding: 0.2rem 0.4rem;
}
button.ghost:hover { color: var(--fg); }

.row { display: flex; gap: var(--gap-sm); align-items: center; flex-wrap: wrap; }
.grow { flex: 1 1 auto; }
.muted { color: var(--fg-muted); font-size: var(--fz-sm); }
.faint { color: var(--fg-faint); }

/* Pill / badge */
.pill {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  border-radius: var(--radius);
  font-size: var(--fz-sm);
  font-weight: 700;
  font-family: var(--font);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg-muted);
}
.pill-allow    { background: #1e3a1e; color: var(--success); border-color: #2a4a2a; }
.pill-deny     { background: #3a1e1e; color: var(--danger);  border-color: #4a2a2a; }
.pill-warn     { background: #3a2e0e; color: var(--warn);    border-color: #4a3a1a; }
.pill-info     { background: #2a1e3a; color: var(--info);    border-color: #3a2a4a; }
.pill-accent   { background: var(--accent-soft); color: var(--accent); border-color: var(--border-strong); }
.pill-muted    { background: var(--surface-2); color: var(--fg-muted); }
.pill-override { background: #3a2e0e; color: var(--warn);    border-color: #4a3a1a; }
.pill-file     { background: var(--accent-soft); color: var(--accent); border-color: var(--border-strong); }

/* Card */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: var(--gap) 0;
  box-shadow: 3px 3px #000;
}
.card.muted { background: var(--surface-2); opacity: 0.85; }
.card-header {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: 0.5rem 0.85rem;
  border-bottom: 1px solid var(--border);
  background:
    linear-gradient(225deg, var(--bg) 0 8px, var(--border-strong) 8px 9px, transparent 9px) top right / 14px 14px no-repeat,
    var(--surface-2);
  font: 700 var(--fz-sm)/1.5 var(--font);
}
.card-header .actions { margin-left: auto; }
.card-body { padding: 0.85rem; }

/* Dashboard summary */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--gap);
  margin-bottom: 1.25rem;
}
.kpi-strip .kpi {
  min-width: 0;
  border-top: 2px solid var(--accent);
}
.kpi-strip .kpi-value { overflow-wrap: anywhere; }
@media (max-width: 440px) {
  .kpi-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-strip .kpi:last-child { grid-column: 1 / -1; }
}

.kpi {
  display: inline-block;
  padding: 0.5rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-width: 6rem;
}
.kpi-label {
  display: block;
  font-size: var(--fz-sm);
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.kpi-value {
  display: block;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--fg);
  line-height: 1.2;
}
.kpi-hint { font-size: var(--fz-sm); color: var(--fg-faint); }

/* Sparkline */
.spark {
  display: inline-block;
  vertical-align: middle;
  font-family: var(--font);
  color: var(--accent);
  letter-spacing: 0;
}
.spark-empty { color: var(--fg-faint); }

/* Tag list */
.tag-list { display: inline-flex; gap: 0.25rem; flex-wrap: wrap; }

/* Keyboard hint */
kbd {
  font-family: var(--font);
  font-size: var(--fz-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: var(--radius);
  padding: 0.05rem 0.35rem;
  color: var(--fg);
}

/* Forms */
label { display: block; margin: 0.5rem 0 0.25rem; color: var(--fg-muted); font-size: var(--fz-sm); }
.field { margin-bottom: var(--gap); }
.field input, .field textarea, .field select { width: 100%; }

/* Metrics page */
.metrics-table { width: 100%; border-collapse: collapse; }
.metrics-table th { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border-strong); color: var(--fg-muted); font-weight: normal; font-size: var(--fz-sm); }
.metrics-table td { padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border); font-size: var(--fz-sm); }
.metrics-table a { color: var(--accent); text-decoration: none; }
.metrics-table a:hover { text-decoration: underline; }
.metrics-table { min-width: 40rem; }
.metrics-scope { margin: 0 0 var(--gap); color: var(--fg-muted); font-size: var(--fz-sm); }
.metrics-scope time { white-space: nowrap; }
.kpi-strip .kpi-primary .kpi-value { font-size: 2rem; }
.kpi-strip .kpi-primary { grid-column: span 2; }
@media (max-width: 440px) { .kpi-strip .kpi-primary { grid-column: 1 / -1; } }
.metrics-actions { margin: 0 0 var(--gap); }
.metrics-details { margin-top: var(--gap); }
.metrics-details > summary { cursor: pointer; color: var(--fg-muted); }
.empty-state { color: var(--fg-muted); font-style: italic; }

/* Responsive tables: scroll sideways instead of breaking numbers and headers apart */
.table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
td.num, th.num, .nowrap { white-space: nowrap; overflow-wrap: normal; word-break: normal; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
th { white-space: nowrap; overflow-wrap: normal; }
.spark { white-space: nowrap; overflow-wrap: normal; }
td.spark-cell { white-space: nowrap; overflow-wrap: normal; min-width: 8rem; }

/* Deny-by-rule bars (HTML list, wraps on phones) */
.rule-bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--gap-sm); }
.rule-bars li { min-width: 0; }
.rule-bars .rule-head { display: flex; gap: var(--gap-sm); align-items: baseline; justify-content: space-between; }
.rule-bars .rule-name { min-width: 0; overflow-wrap: anywhere; }
.rule-bars .rule-count { flex: none; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rule-bars .rule-bar { display: block; height: 0.5rem; margin-top: 0.2rem; border-radius: 2px; background: var(--surface-2); }
.rule-bars .rule-bar > span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.rule-bars-note { margin: var(--gap-sm) 0 0; color: var(--fg-muted); font-size: var(--fz-sm); }

/* Touch devices: comfortable targets and no iOS zoom-on-focus */
@media (pointer: coarse) {
  .site-header nav a, .site-header nav button { min-height: 44px; display: inline-flex; align-items: center; }
  button, .btn-allow, .btn-deny { min-height: 44px; }
  button.ghost { padding: 0.5rem 0.75rem; }
  input, textarea, select { font-size: 16px; min-height: 44px; }
  .row { gap: 0.6rem; }
}
`;

export function HEAD(title: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="${THEME_COLOR}" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Approvals" />
<link rel="manifest" href="/admin/manifest.webmanifest" crossorigin="use-credentials" />
<link rel="icon" type="image/svg+xml" href="/admin/brand/splicedock-mark.svg" />
<link rel="apple-touch-icon" href="/admin/icon-180.png" />
<title>${escapeHtml(title)} · Splicedock</title>
<script src="https://unpkg.com/alpinejs@3.14.9/dist/cdn.min.js" integrity="sha384-9Ax3MmS9AClxJyd5/zafcXXjxmwFhZCdsT6HJoJjarvCaAkJlk5QDzjLJm+Wdx5F" crossorigin="anonymous" defer></script>
<style>${STYLES}${DIALOG_STYLES}</style>
<script>${SHARED_SCRIPTS}</script>
<script>${DIALOG_SCRIPT}</script>
</head><body>`;
}

export const FOOT = `</body></html>`;

interface NavLink {
  href: string;
  label: string;
  key: string;
}

const NAV_LINKS: ReadonlyArray<NavLink> = [
  { href: '/admin/', label: 'tools', key: 'tools' },
  { href: '/admin/audit', label: 'audit', key: 'audit' },
  { href: '/admin/approvals', label: 'approvals', key: 'approvals' },
  { href: '/admin/profiles', label: 'profiles', key: 'profiles' },
  { href: '/admin/swipe', label: 'swipe', key: 'swipe' },
  { href: '/admin/metrics', label: 'metrics', key: 'metrics' },
];

export function NAV(active?: string): string {
  const links = NAV_LINKS.map((l) => {
    const cls = active === l.key ? ' class="active" aria-current="page"' : '';
    return `<a href="${escapeHtml(l.href)}"${cls}>${escapeHtml(l.label)}</a>`;
  }).join('\n');
  return `<a class="skip-link" href="#admin-main">Skip to content</a>
<header class="site-header"><nav aria-label="Admin">
<a href="/admin/" class="brand">${BRAND}</a>
<div class="nav-links">${links}</div>
<form action="/admin/logout" method="post" class="logout-form"><button type="submit" class="ghost">logout</button></form>
</nav></header>`;
}

/** Render a full page: HEAD + optional NAV + <main>body</main> + FOOT. */
export function renderPage(opts: {
  title: string;
  navKey?: string;
  body: string;
  status?: number;
}): string {
  const nav = opts.navKey !== undefined ? `\n${NAV(opts.navKey)}` : '';
  return `${HEAD(opts.title)}${nav}\n<main id="admin-main" tabindex="-1">\n${opts.body}\n</main>\n${FOOT}`;
}
