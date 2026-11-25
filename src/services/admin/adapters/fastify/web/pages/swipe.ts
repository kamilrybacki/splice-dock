// Swipe page — mobile-first card stack of pending approvals for /admin/swipe.
// Swipe right (or tap ✓ / press →) approves, swipe left (✕ / ←) rejects.
//
// The page is a static shell: cards are fetched and rendered on the client by
// polling GET /api/v1/approvals?status=pending, so nothing user-controlled is
// interpolated server-side.
//
// Security:
//   - Cards are built with createElement + textContent only; no innerHTML.
//   - The approval id is encodeURIComponent'd before going into the API path.
//   - POSTs carry the CSRF header via the SHARED_SCRIPTS fetch wrapper.
//   - Strong (WebAuthn) approvals cannot be approved here; the API answers
//     409 webauthn_required and the card is marked and sent to the back.
//
// Endpoints used by client JS:
//   GET  /api/v1/approvals?status=pending&limit=100
//   POST /api/v1/approvals/:id/approve
//   POST /api/v1/approvals/:id/reject

const STYLES = `
main.swipe-main { max-width: 520px; padding-top: var(--gap-sm); }
body { padding-top: env(safe-area-inset-top); }
/* A card flying off-screen (translate 150vw) must not widen the document, and a
   sideways drag must never pan the page: clip horizontal overflow on this page. */
html, body { overflow-x: hidden; overflow-x: clip; overscroll-behavior-x: none; }
.swipe-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--gap-sm); }
.swipe-head h2 { margin: 0; }
#swipe-deck { position: relative; height: min(62vh, 520px); margin: 0 auto; }
.swipe-card {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: var(--gap-sm);
  padding: var(--gap); background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.45); overflow: hidden;
  touch-action: pan-y; user-select: none; -webkit-user-select: none;
  transition: transform .25s ease, opacity .25s ease; will-change: transform;
}
.swipe-card.under { transform: scale(.95) translateY(12px); opacity: .6; pointer-events: none; }
.swipe-card.under2 { transform: scale(.9) translateY(24px); opacity: .3; pointer-events: none; }
.swipe-card .tool { font-size: 1.6em; font-weight: 700; color: var(--fg); word-break: break-all; }
.swipe-card pre.argv {
  margin: 0; padding: var(--gap-sm); background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); white-space: pre-wrap; word-break: break-all;
  color: var(--accent); font-size: var(--fz);
}
.swipe-card .meta { font-size: var(--fz-sm); color: var(--fg-muted); word-break: break-all; }
.swipe-card .meta b { color: var(--fg-faint); font-weight: 400; }
.swipe-card .foot { display: flex; justify-content: space-between; font-size: var(--fz-sm); color: var(--fg-muted); }
.swipe-card .swipe-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--gap-sm); touch-action: pan-y; }
.swipe-card .swipe-body > * { flex: none; }
.swipe-card .details-link { font-size: var(--fz-sm); align-self: flex-start; }
.swipe-card .strong-note { color: var(--warn); font-size: var(--fz-sm); }
.stamp {
  position: absolute; top: 18px; padding: 4px 10px; border: 3px solid; border-radius: 8px;
  font-size: 1.4em; font-weight: 800; letter-spacing: .1em; opacity: 0; pointer-events: none;
}
.stamp.approve { left: 18px; color: var(--success); border-color: var(--success); transform: rotate(-14deg); }
.stamp.reject { right: 18px; color: var(--danger); border-color: var(--danger); transform: rotate(14deg); }
.swipe-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--fg-muted); text-align: center; }
.swipe-empty .big { font-size: 3em; }
.swipe-actions { display: flex; justify-content: center; gap: 48px; margin-top: var(--gap); padding-bottom: env(safe-area-inset-bottom); }
.swipe-actions button {
  width: 72px; height: 72px; border-radius: 50%; font-size: 2em; line-height: 1;
  background: var(--surface); border: 2px solid; cursor: pointer;
}
.swipe-actions button:disabled { opacity: .35; }
.swipe-actions .no { color: var(--danger); border-color: var(--danger); }
.swipe-actions .yes { color: var(--success); border-color: var(--success); }
#swipe-toast {
  position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: 90vw;
  padding: 8px 14px; background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius); font-size: var(--fz-sm); opacity: 0; transition: opacity .2s;
  pointer-events: none;
}
#swipe-toast.show { opacity: 1; }
.swipe-push { display: block; width: 100%; margin-bottom: var(--gap-sm); padding: 8px; background: var(--surface); color: var(--fg); border: 1px solid var(--border-strong); border-radius: var(--radius); cursor: pointer; }
.swipe-push[hidden] { display: none; }
`;

const SCRIPT = `
(function () {
  var POLL_MS = 5000;
  var THRESHOLD = 90;
  var deck = document.getElementById('swipe-deck');
  var counter = document.getElementById('swipe-count');
  var toastEl = document.getElementById('swipe-toast');
  var btnNo = document.getElementById('swipe-no');
  var btnYes = document.getElementById('swipe-yes');
  var queue = [];
  var inFlight = {};
  var strong = {};
  var busy = false;
  var dragging = false;
  var decidedAt = 0;
  var toastTimer;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(function () {});
  }

  // Push opt-in: shown only when the browser supports it and the server has
  // VAPID keys. iOS needs the app installed to the home screen first.
  var btnPush = document.getElementById('swipe-push');
  function b64ToBytes(s) {
    var b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  async function setupPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    var res;
    try { res = await fetch('/api/v1/push/vapid-public-key', { headers: { accept: 'application/json' }, credentials: 'same-origin' }); } catch (_) { return; }
    if (res.status !== 200) return;
    var key = (await res.json()).publicKey;
    if (typeof key !== 'string' || !key) return;
    var reg = await navigator.serviceWorker.ready;
    var existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === 'granted') { await sendSub(existing); return; }
    btnPush.hidden = false;
    btnPush.addEventListener('click', async function () {
      btnPush.disabled = true;
      try {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications blocked'); btnPush.disabled = false; return; }
        var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        if (await sendSub(sub)) { btnPush.hidden = true; toast('Notifications on'); }
        else { toast('Could not enable notifications'); btnPush.disabled = false; }
      } catch (_) { toast('Could not enable notifications'); btnPush.disabled = false; }
    });
  }
  async function sendSub(sub) {
    try {
      var r = await fetch('/api/v1/push/subscribe', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-splicedock-csrf': '1' },
        body: JSON.stringify(sub.toJSON())
      });
      return r.ok;
    } catch (_) { return false; }
  }
  setupPush().catch(function () {});

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2500);
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }
  function fmtArgv(argv) {
    return (argv || []).map(function (a) { return /[\\s"']/.test(a) ? JSON.stringify(a) : a; }).join(' ');
  }
  function left(ms) {
    if (ms <= 0) return 'expired';
    var m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return m + 'm ' + s + 's';
  }

  function metaLine(label, value) {
    var d = el('div', 'meta');
    d.appendChild(el('b', null, label + ' '));
    d.appendChild(document.createTextNode(value));
    return d;
  }

  function buildCard(row) {
    var c = el('div', 'swipe-card');
    c.dataset.id = row.id;
    c.appendChild(el('div', 'stamp approve', 'APPROVE'));
    c.appendChild(el('div', 'stamp reject', 'REJECT'));
    // One scroll area for all review content; stamps and the footer stay put.
    var body = el('div', 'swipe-body');
    body.appendChild(el('div', 'tool', row.tool));
    if (strong[row.id]) body.appendChild(el('div', 'strong-note', 'strong approval: needs the WebAuthn consent link'));
    body.appendChild(el('pre', 'argv', fmtArgv(row.argv)));
    if (row.approval_context) body.appendChild(metaLine('why', row.approval_context));
    if (row.cwd) body.appendChild(metaLine('cwd', row.cwd));
    body.appendChild(metaLine('rule', row.rule + (row.matched ? ' (' + row.matched + ')' : '')));
    var more = el('a', 'details-link', 'full details \u2192');
    more.href = '/admin/approvals/' + encodeURIComponent(row.id);
    body.appendChild(more);
    c.appendChild(body);
    var foot = el('div', 'foot');
    foot.appendChild(el('span', null, typeof window.timeAgo === 'function' ? window.timeAgo(row.requested_at) : ''));
    var cd = el('span', 'countdown');
    cd.dataset.expires = String(row.expires_at);
    foot.appendChild(cd);
    c.appendChild(foot);
    return c;
  }

  function visible() {
    var now = Date.now();
    return queue.filter(function (r) { return !inFlight[r.id] && r.expires_at > now; });
  }

  function render() {
    var rows = visible();
    counter.textContent = rows.length + ' pending';
    document.title = (rows.length ? '(' + rows.length + ') ' : '') + 'Swipe · Splicedock';
    while (deck.firstChild) deck.removeChild(deck.firstChild);
    btnNo.disabled = btnYes.disabled = rows.length === 0;
    if (!rows.length) {
      var empty = el('div', 'swipe-empty');
      empty.appendChild(el('div', 'big', '✓'));
      empty.appendChild(el('div', null, 'Nothing to approve'));
      deck.appendChild(empty);
      return;
    }
    var shown = rows.slice(0, 3);
    for (var i = shown.length - 1; i >= 0; i--) {
      var card = buildCard(shown[i]);
      if (i === 1) card.classList.add('under');
      if (i === 2) card.classList.add('under2');
      deck.appendChild(card);
      if (i === 0) attachDrag(card, shown[i]);
    }
    tick();
  }

  function tick() {
    var now = Date.now();
    var els = deck.querySelectorAll('.countdown');
    for (var i = 0; i < els.length; i++) els[i].textContent = 'expires in ' + left(Number(els[i].dataset.expires) - now);
  }

  function setDrag(card, dx, dy) {
    card.style.transform = 'translate(' + dx + 'px,' + dy * 0.25 + 'px) rotate(' + dx / 14 + 'deg)';
    var p = Math.min(1, Math.abs(dx) / THRESHOLD);
    card.querySelector('.stamp.approve').style.opacity = dx > 0 ? p : 0;
    card.querySelector('.stamp.reject').style.opacity = dx < 0 ? p : 0;
  }

  function attachDrag(card, row) {
    var sx = 0, sy = 0, dx = 0, dy = 0;
    card.addEventListener('pointerdown', function (e) {
      if (busy) return;
      if (e.target && e.target.closest && e.target.closest('a')) return; // let links navigate
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      card.style.transition = 'none';
      try { card.setPointerCapture(e.pointerId); } catch (_) {}
    });
    card.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      setDrag(card, dx, dy);
    });
    function end(commit) {
      if (!dragging) return;
      dragging = false;
      card.style.transition = '';
      if (commit && dx > THRESHOLD) decide(row, 'approve', card);
      else if (commit && dx < -THRESHOLD) decide(row, 'reject', card);
      else setDrag(card, 0, 0);
    }
    card.addEventListener('pointerup', function () { end(true); });
    // pointercancel = browser took over (scroll, system gesture): never decide.
    card.addEventListener('pointercancel', function () { end(false); });
  }

  async function decide(row, action, card) {
    if (busy) return;
    if (action === 'approve' && strong[row.id]) {
      toast('Strong approval: use the WebAuthn consent link');
      if (card) setDrag(card, 0, 0);
      return;
    }
    busy = true;
    var dir = action === 'approve' ? 1 : -1;
    if (card) {
      card.style.transform = 'translate(' + dir * 150 + 'vw, 0) rotate(' + dir * 30 + 'deg)';
      card.style.opacity = '0';
    }
    inFlight[row.id] = true;
    buzz(action === 'approve' ? 25 : [15, 40, 15]);
    try {
      var res = await fetch('/api/v1/approvals/' + encodeURIComponent(row.id) + '/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      if (res.ok) {
        queue = queue.filter(function (r) { return r.id !== row.id; });
        toast((action === 'approve' ? 'Approved ' : 'Rejected ') + row.tool);
      } else {
        var code = '';
        try { code = ((await res.json()).error || {}).code || ''; } catch (_) {}
        if (code === 'webauthn_required') {
          strong[row.id] = true;
          queue = queue.filter(function (r) { return r.id !== row.id; }).concat([row]);
          toast('Strong approval: use the WebAuthn consent link');
        } else if (code === 'not_pending') {
          queue = queue.filter(function (r) { return r.id !== row.id; });
          toast('Already decided or expired');
        } else if (res.status === 401 || res.status === 403) {
          location.href = '/admin/login';
          return;
        } else {
          toast('Failed (' + res.status + ')');
        }
      }
    } catch (_) {
      toast('Network error');
    } finally {
      delete inFlight[row.id];
      decidedAt = Date.now();
      busy = false;
      setTimeout(render, card ? 200 : 0);
    }
  }

  function topRow() { return visible()[0]; }
  function act(action) {
    var row = topRow();
    if (!row) return;
    decide(row, action, deck.querySelector('.swipe-card:not(.under):not(.under2)'));
  }
  btnNo.addEventListener('click', function () { act('reject'); });
  btnYes.addEventListener('click', function () { act('approve'); });
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowRight') act('approve');
    else if (e.key === 'ArrowLeft') act('reject');
  });

  function sameIds(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
    return true;
  }

  async function poll() {
    if (document.hidden || busy) return;
    var started = Date.now();
    try {
      var res = await fetch('/api/v1/approvals?status=pending&limit=100', { headers: { accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) { location.href = '/admin/login'; return; }
      if (!res.ok) return;
      var rows = ((await res.json()).data || []).filter(function (r) { return r.status === 'pending'; });
      // A decision landed while this poll was in flight: its rows may be stale.
      if (decidedAt >= started || busy) return;
      rows.sort(function (a, b) { return a.expires_at - b.expires_at; });
      var front = rows.filter(function (r) { return !strong[r.id]; });
      var back = rows.filter(function (r) { return strong[r.id]; });
      var next = front.concat(back);
      if (!sameIds(next, queue)) {
        if (next.length > queue.length && queue.length) buzz(10);
        queue = next;
        if (!busy && !dragging) render();
      }
    } catch (_) { /* offline: keep current cards */ }
  }

  render();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(function () { tick(); if (!busy && !dragging && Math.min(3, visible().length) !== deck.querySelectorAll('.swipe-card').length) render(); }, 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
`;

/** Inner body for /admin/swipe; the caller wraps it in HEAD, NAV and FOOT. */
export function renderSwipePage(): string {
  return `<style>${STYLES}</style>
<div class="swipe-head"><h2>approvals</h2><span id="swipe-count" class="muted">loading…</span></div>
<button type="button" id="swipe-push" class="swipe-push" hidden>🔔 enable notifications</button>
<div id="swipe-deck" aria-live="polite"></div>
<div class="swipe-actions">
  <button type="button" id="swipe-no" class="no" aria-label="reject" disabled>✕</button>
  <button type="button" id="swipe-yes" class="yes" aria-label="approve" disabled>✓</button>
</div>
<p class="muted" style="text-align:center;font-size:var(--fz-sm)">swipe → approve · ← reject · <a href="/admin/approvals">list view</a></p>
<div id="swipe-toast" role="status"></div>
<script>${SCRIPT}</script>`;
}
