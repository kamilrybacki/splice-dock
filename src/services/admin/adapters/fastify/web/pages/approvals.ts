// Approvals page — tabbed view (pending/approved/rejected/expired/reserved/consumed/all)
// with two layouts: cards for pending (with live countdown + approve/reject
// buttons) and a compact table for terminal statuses.
//
// Returns the inner body for /admin/approvals and /admin/approvals/:id
// (between <main>...</main>); the caller wraps it in HEAD, NAV, and FOOT.
//
// Security:
//   - Every user-controlled value (id, tool, rule, matched, argv) is
//     HTML-escaped server-side via escapeHtml().
//   - The approval id is also encodeURIComponent'd on the client before being
//     embedded into the API path.
//   - Buttons read the id from a data-* attribute via element.dataset, never
//     from a string-interpolated JS literal.
//   - No x-html / innerHTML with user data.
//
// Endpoints used by client JS:
//   POST /api/v1/approvals/:id/approve
//   POST /api/v1/approvals/:id/reject

import { escapeHtml, pill } from '../components.js';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'reserved'
  | 'consumed'
  | 'failed';

export interface ApprovalRowSummary {
  id: string;
  tool: string;
  argv: string[];
  rule: string;
  matched: string | null;
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  /** Resolved working directory the approval is bound to; null for legacy rows. */
  cwd?: string | null;
  approval_context?: string | null;
  consent_method?: string | null;
}

export interface ApprovalRowDetail extends ApprovalRowSummary {
  approved_at: number | null;
  approved_by: string | null;
  consumed_at: number | null;
}

export interface ApprovalsPageInput {
  rows: ApprovalRowSummary[];
  activeTab: string;
}

export interface ApprovalDetailInput {
  row: ApprovalRowDetail;
}

const TABS: ReadonlyArray<string> = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'reserved',
  'consumed',
  'failed',
  'all',
  'grant',
  'automatic',
];

const STYLES = `
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: var(--gap); overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
.tabs::-webkit-scrollbar { display: none; }
.tab-link { padding: 0.5rem var(--gap); color: var(--fg-muted); text-decoration: none; border-bottom: 2px solid transparent; }
.tab-link:hover { color: var(--fg); text-decoration: none; }
.tab-link.active { color: var(--accent); border-bottom-color: var(--accent); }
.approval-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--gap); margin-bottom: var(--gap); }
.approval-card pre { background: var(--surface-2); padding: 0.5rem; border-radius: var(--radius); margin: var(--gap-sm) 0; font-size: var(--fz-sm); white-space: pre-wrap; word-break: break-all; }
.approval-meta { color: var(--fg-muted); font-size: var(--fz-sm); margin: var(--gap-sm) 0; }
.approval-card .pill, .approval-card .row > *, .approval-meta { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.approval-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: var(--gap); }
.btn-allow { background: var(--success); color: #000; border: none; padding: 0.4rem 1rem; border-radius: var(--radius); cursor: pointer; font: inherit; }
.btn-allow:hover { filter: brightness(1.1); }
.btn-allow:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-deny { background: var(--danger); color: #000; border: none; padding: 0.4rem 1rem; border-radius: var(--radius); cursor: pointer; font: inherit; }
.btn-deny:hover { filter: brightness(1.1); }
.btn-deny:disabled { opacity: 0.6; cursor: not-allowed; }
.countdown { color: var(--warn); }
.approval-table { width: 100%; border-collapse: collapse; font-size: var(--fz-sm); }
.approval-table th { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border-strong); color: var(--fg-muted); font-weight: normal; }
.approval-table td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.approval-table code { background: var(--surface-2); }
`;

const ACTION_SCRIPT = `
(function () {
  function updateCountdowns() {
    var nodes = document.querySelectorAll('.countdown[data-expires]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var exp = +el.dataset.expires;
      var diff = exp - Date.now();
      if (!isFinite(exp)) { el.textContent = ''; continue; }
      if (diff <= 0) { el.textContent = 'expired'; continue; }
      var m = Math.floor(diff / 60000);
      var s = Math.floor((diff % 60000) / 1000);
      el.textContent = 'expires in ' + m + 'm ' + s + 's';
    }
  }
  updateCountdowns();
  setInterval(updateCountdowns, 1000);

  window.handleApproval = async function (btn, action) {
    var id = btn.dataset.id;
    if (!id) return;
    var card = btn.closest('.approval-card');
    var buttons = card ? card.querySelectorAll('button') : [btn];
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    try {
      var res = await fetch('/api/v1/approvals/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (res.ok) {
        var redirect = btn.dataset.redirect || '/admin/approvals?status=pending';
        location.href = redirect;
      } else {
        for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
        btn.textContent = 'failed';
      }
    } catch (_) {
      for (var k = 0; k < buttons.length; k++) buttons[k].disabled = false;
      btn.textContent = 'failed';
    }
  };
})();
`;

function approvalStatusVariant(status: ApprovalStatus): string {
  if (status === 'pending') return 'warn';
  if (status === 'approved') return 'allow';
  if (status === 'rejected') return 'deny';
  if (status === 'expired') return 'muted';
  return 'info';
}

function renderTabs(activeTab: string): string {
  const items = TABS.map((t) => {
    const href = `/admin/approvals?status=${encodeURIComponent(t)}`;
    const cls = t === activeTab ? 'tab-link active' : 'tab-link';
    return `<a href="${escapeHtml(href)}" class="${cls}">${t==='automatic'?'Automatic approvals':t==='grant'?'Grant history':escapeHtml(t)}</a>`;
  }).join('');
  return `<nav class="tabs" aria-label="approval status tabs">${items}</nav>`;
}

function renderArgvBlock(argv: string[]): string {
  // Render argv as `$ arg0 arg1 ...` on the first line, then any additional
  // groupings preserved. We escape every element individually before joining.
  const safe = argv.map((a) => escapeHtml(a)).join(' ');
  return `<pre>$ ${safe}</pre>`;
}

function renderTimeInfo(row: ApprovalRowSummary): string {
  const reqIso = escapeHtml(new Date(row.requested_at).toISOString());
  const expIso = escapeHtml(new Date(row.expires_at).toISOString());
  const reqTs = String(row.requested_at);
  const expTs = String(row.expires_at);
  const isPending = row.status === 'pending';
  const countdown = isPending
    ? `<span class="countdown" data-expires="${escapeHtml(expTs)}">expires in …</span>`
    : `<span title="${expIso}">${expIso.slice(0, 10)}</span>`;
  return `<div class="approval-meta">
    requested <span data-ts="${escapeHtml(reqTs)}" title="${reqIso}">${reqIso}</span>
    · ${countdown}
  </div>`;
}

/** The cwd is part of what the operator approves, so it is always shown.
 *  Legacy rows (created before the cwd binding) have none and can never be
 *  consumed. */
function renderCwd(cwd: string | null | undefined): string {
  const value = cwd ? escapeHtml(cwd) : '(legacy: none recorded; cannot be consumed)';
  return `<div class="approval-meta">cwd <code>${value}</code></div>`;
}

function renderPendingCard(row: ApprovalRowSummary): string {
  const id = escapeHtml(row.id);
  const idPath = escapeHtml(encodeURIComponent(row.id));
  const tool = pill(row.tool, 'accent');
  const rule = pill(row.rule, 'info');
  const matchedPill = row.matched ? ` ${pill(row.matched, 'muted')}` : '';
  return `<article class="approval-card" id="row-${id}">
    <div class="row">${tool} ${rule}${matchedPill}</div>
    ${renderArgvBlock(row.argv)}
    ${renderCwd(row.cwd)}
    <p>${escapeHtml(row.approval_context ?? '')}</p>
    ${renderTimeInfo(row)}
    <div class="approval-actions">
      <button type="button" class="btn-allow" data-id="${id}" onclick="handleApproval(this, 'approve')">approve</button>
      <button type="button" class="btn-deny" data-id="${id}" onclick="handleApproval(this, 'reject')">reject</button>
      <a href="/admin/approvals/${idPath}" class="muted" style="align-self:center">details →</a>
    </div>
  </article>`;
}

function renderPendingList(rows: ApprovalRowSummary[]): string {
  if (rows.length === 0) {
    return `<p class="muted">(no pending approvals)</p>`;
  }
  return rows.map(renderPendingCard).join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function renderTableRow(row: ApprovalRowSummary): string {
  const shortId = row.id.length > 8 ? row.id.slice(0, 8) : row.id;
  const firstArg = row.argv.length > 0 ? row.argv[0] : '';
  const argvShort = truncate(firstArg ?? '', 40);
  const reqIso = new Date(row.requested_at).toISOString();
  const expIso = new Date(row.expires_at).toISOString();
  const idPath = escapeHtml(encodeURIComponent(row.id));
  return `<tr>
    <td><a href="/admin/approvals/${idPath}"><code>${escapeHtml(shortId)}</code></a></td>
    <td>${escapeHtml(row.tool)}</td>
    <td><code title="${escapeHtml(firstArg ?? '')}">${escapeHtml(argvShort)}</code></td>
    <td>${escapeHtml(row.rule)}</td>
    <td>${pill(row.status, approvalStatusVariant(row.status))}</td>
    <td class="muted" title="${escapeHtml(reqIso)}">${escapeHtml(reqIso)}</td>
    <td class="muted" title="${escapeHtml(expIso)}">${escapeHtml(expIso)}</td>
  </tr>`;
}

function renderTable(rows: ApprovalRowSummary[], activeTab: string): string {
  if (rows.length === 0) {
    return `<p class="muted">(no ${escapeHtml(activeTab)} approvals)</p>`;
  }
  const body = rows.map(renderTableRow).join('\n');
  return `<table class="approval-table">
    <thead><tr>
      <th>id</th><th>tool</th><th>argv</th><th>rule</th><th>status</th><th>requested</th><th>expires</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

export function renderApprovalsPage(view: ApprovalsPageInput): string {
  const active = TABS.includes(view.activeTab) ? view.activeTab : 'pending';
  const body = active === 'pending'
    ? renderPendingList(view.rows)
    : renderTable(view.rows, active);
  return `<style>${STYLES}</style>
<script>${ACTION_SCRIPT}</script>
<h2>approvals</h2>
${renderTabs(active)}
${body}`;
}

export function renderApprovalDetail(view: ApprovalDetailInput): string {
  const row = view.row;
  const id = escapeHtml(row.id);
  const idPath = escapeHtml(encodeURIComponent(row.id));
  const tool = pill(row.tool, 'accent');
  const statusPill = pill(row.status, approvalStatusVariant(row.status));
  const matchedPill = row.matched ? ` ${pill(row.matched, 'muted')}` : '';
  const rulePill = pill(row.rule, 'info');
  const reqIso = escapeHtml(new Date(row.requested_at).toISOString());
  const expIso = escapeHtml(new Date(row.expires_at).toISOString());
  const expTs = String(row.expires_at);
  const isPending = row.status === 'pending';
  const countdown = isPending
    ? `<span class="countdown" data-expires="${escapeHtml(expTs)}">expires in …</span>`
    : `<span>${expIso}</span>`;
  const approvedAt = row.approved_at
    ? `<div class="approval-meta">approved at <span>${escapeHtml(new Date(row.approved_at).toISOString())}</span>${row.approved_by ? ` by <code>${escapeHtml(row.approved_by)}</code>` : ''}</div>`
    : '';
  const consumedAt = row.consumed_at
    ? `<div class="approval-meta">consumed at <span>${escapeHtml(new Date(row.consumed_at).toISOString())}</span></div>`
    : '';
  const actions = isPending
    ? `<div class="approval-actions">
        <button type="button" class="btn-allow" data-id="${id}" data-redirect="/admin/approvals/${idPath}" onclick="handleApproval(this, 'approve')">approve</button>
        <button type="button" class="btn-deny" data-id="${id}" data-redirect="/admin/approvals/${idPath}" onclick="handleApproval(this, 'reject')">reject</button>
      </div>`
    : `<p class="muted">not pending; no actions available</p>`;
  return `<style>${STYLES}</style>
<script>${ACTION_SCRIPT}</script>
<p><a href="/admin/approvals?status=pending">← back to approvals</a></p>
<h2>approval ${id}</h2>
<article class="approval-card">
  <div class="row">${statusPill} ${tool} ${rulePill}${matchedPill}</div>
  ${renderArgvBlock(row.argv)}
  ${renderCwd(row.cwd)}
    <p>${escapeHtml(row.approval_context ?? '')}</p>
  <div class="approval-meta">
    requested <span title="${reqIso}">${reqIso}</span>
    · ${countdown}
  </div>
  ${approvedAt}
  ${consumedAt}
  ${actions}
</article>`;
}
