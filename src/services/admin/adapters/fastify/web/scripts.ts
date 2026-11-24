// Shared client-side helpers embedded in every admin page.
//
// Exposed as a single string so layout.ts can drop it inside a <script> tag.
// Contents:
//   - window.cApi(method, url, body)  fetch wrapper, throws on !ok
//   - window.timeAgo(timestampMs)

export const SHARED_SCRIPTS: string = `
(function () {
  // CSRF: every same-origin state-changing fetch carries a custom header, which
  // the server requires for cookie-authenticated requests (cross-site pages
  // cannot set it). Wrapped once here so no individual page can forget it.
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameOrigin = url.charAt(0) === '/' && url.charAt(1) !== '/' || url.indexOf(location.origin + '/') === 0;
      if (sameOrigin) {
        var h = new Headers(init.headers || (input && input.headers) || undefined);
        h.set('x-splicedock-csrf', '1');
        init = Object.assign({}, init, { headers: h });
      }
    }
    return origFetch(input, init);
  };

  document.addEventListener('submit', async function (event) {
    var form = event.target;
    if (form instanceof HTMLFormElement && form.getAttribute('action') === '/admin/logout') {
      event.preventDefault();
      var response = await fetch('/admin/logout', { method: 'POST' });
      if (response.ok) location.assign('/admin/login');
    }
  });

  window.cApi = async function (method, url, body) {
    var init = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res = await fetch(url, init);
    if (!res.ok) {
      var text = '';
      try { text = await res.text(); } catch (_) {}
      var err = new Error('HTTP ' + res.status + (text ? ': ' + text : ''));
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (res.status === 204) return null;
    var ctype = res.headers.get('content-type') || '';
    if (ctype.indexOf('application/json') !== -1) return res.json();
    return res.text();
  };

  window.timeAgo = function (ts) {
    if (!ts && ts !== 0) return '';
    var n = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!isFinite(n)) return '';
    var diff = Math.max(0, Date.now() - n);
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 30) return d + 'd ago';
    var mo = Math.floor(d / 30);
    if (mo < 12) return mo + 'mo ago';
    var y = Math.floor(d / 365);
    return y + 'y ago';
  };
})();
`;
