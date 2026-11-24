// Login page HTML renderer for the Splicedock admin UI.

import { BRAND, HEAD, FOOT } from '../layout.js';
import { escapeHtml } from '../components.js';

export function renderLoginPage(opts: { error?: boolean } = {}): string {
  const errorHtml = opts.error
    ? `<p role="alert" style="color:var(--danger)">Invalid token.</p>\n`
    : '';
  const envVar = escapeHtml(process.env['SPLICEDOCK_ADMIN_TOKEN_ENV'] ?? process.env['SPLICEDOCK_ADMIN_TOKEN_ENV'] ?? 'SPLICEDOCK_ADMIN_TOKEN');
  return `${HEAD('Login')}
<main class="login-page">
<div class="login-panel"><article class="card"><div class="card-body">
${BRAND}
<h1>Admin sign-in</h1>
${errorHtml}<form method="post" action="/admin/login">
  <div class="field">
    <label for="admin-token">Admin token</label>
    <input id="admin-token" type="password" name="token" autocomplete="current-password" required autofocus />
  </div>
  <button type="submit" class="primary">Sign in</button>
</form>
<p class="muted">Use the token set in <code>${envVar}</code> on the gateway.</p>
</div></article></div>
</main>${FOOT}`;
}
