// Audit feed page — server-rendered initial batch with client-side filtering
// (tool / decision / argv substring) plus a live SSE stream that prepends new
// rows. Rows are click-expandable to surface full metadata.
//
// Returns the inner body for /admin/audit (between <main>...</main>); the
// caller wraps it in HEAD, NAV, and FOOT.
//
// Security:
//   - Every user-controlled value is HTML-escaped server-side.
//   - Filtering reads from data-* attributes via $el.dataset — no user data
//     is interpolated into Alpine expressions.
//   - SSE-delivered rows are inserted via DOM construction and .textContent,
//     never via innerHTML with raw payload.
//
// Live stream endpoint: /api/v1/audit/stream (raw SSE; see routes/audit.ts).

import { escapeHtml, pill } from '../components.js';
import type { AuditEntry } from '../../../../../application/audit/audit-buffer.js';

export interface AuditPageInput {
  entries: AuditEntry[];
  tools: string[];
}

const STYLES = `
.audit-filter-bar {
  display: flex;
  gap: var(--gap-sm);
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: var(--gap);
}
.audit-filter-bar select,
.audit-filter-bar input {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius);
  font: inherit;
}
.audit-filter-bar input { min-width: 14rem; }
.audit-live-badge {
  margin-left: auto;
  color: var(--success);
  font-size: var(--fz-sm);
}
.audit-live-badge.audit-live-off { color: var(--fg-faint); }
.audit-table { width: 100%; border-collapse: collapse; font-size: var(--fz-sm); }
.audit-table th {
  text-align: left;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--border-strong);
  color: var(--fg-muted);
  font-weight: normal;
}
.audit-table td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.audit-table tr.audit-row { cursor: pointer; }
.audit-table tr.audit-row:hover td { background: var(--surface-2); }
.audit-table tr.audit-row-detail td { background: var(--surface); padding: var(--gap); }
.audit-table tr.audit-row-detail pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: var(--fz-sm);
}
.audit-load-more { margin-top: var(--gap); }
`;

function renderRow(e: AuditEntry, idx: number): string {
  const tool = escapeHtml(e.tool);
  const decision = escapeHtml(e.decision);
  const rule = escapeHtml(e.rule ?? '');
  const requestId = escapeHtml(e.request_id ?? '');
  const tsIso = escapeHtml(Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : String(e.ts || '—'));
  const tsMs = String(e.ts);
  const argvLen = String(e.argv_len);

  // The x-show expression below is a CONSTANT Alpine expression (no user
  // data interpolated): it reads from $el.dataset.* and compares with the
  // x-data state variables. Filter values flow through the DOM dataset,
  // never through the parsed JS source.
  return `<tr class="audit-row"
      data-tool="${tool}"
      data-decision="${decision}"
      data-rule="${rule}"
      @click="expanded = expanded === ${idx} ? null : ${idx}"
      x-show="(!filterTool || $el.dataset.tool === filterTool)
        && (!filterDecision || $el.dataset.decision === filterDecision)
        && (!filterRule || $el.dataset.rule.toLowerCase().includes(filterRule.toLowerCase()))">
    <td class="muted"><span x-text="window.timeAgo(${tsMs})">${tsIso}</span></td>
    <td>${tool}</td>
    <td>${pill(e.decision, e.decision)}</td>
    <td class="muted">${argvLen}</td>
    <td>${rule || '<span class="muted">—</span>'}</td>
  </tr>
  <tr class="audit-row-detail" x-show="expanded === ${idx}">
    <td colspan="5">
      <div class="muted" style="margin-bottom:var(--gap-sm)">
        ts: <code>${tsIso}</code>
        · argv_len: <code>${argvLen}</code>
        ${requestId ? `· request_id: <code>${requestId}</code>` : ''}
      </div>
    </td>
  </tr>`;
}

function renderToolOptions(tools: string[]): string {
  const sorted = [...tools].sort((a, b) => a.localeCompare(b));
  return sorted.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

const LIVE_SCRIPT = `
(function () {
  var FILTER_EXPR =
    "(!filterTool || $el.dataset.tool === filterTool)" +
    " && (!filterDecision || $el.dataset.decision === filterDecision)" +
    " && (!filterRule || $el.dataset.rule.toLowerCase().includes(filterRule.toLowerCase()))";

  function mkCell(text, className) {
    var td = document.createElement('td');
    if (className) td.className = className;
    if (text != null) td.textContent = text;
    return td;
  }
  function mkMutedDash() {
    var s = document.createElement('span'); s.className = 'muted'; s.textContent = '—'; return s;
  }
  function buildRowPair(e, idx) {
    var tool = String(e.tool || '');
    var decision = String(e.decision || '');
    var rule = e.rule == null ? '' : String(e.rule);
    var ts = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts);
    var requestId = e.request_id == null ? '' : String(e.request_id);
    var argvLen = e.argv_len == null ? '' : String(e.argv_len);

    var tr = document.createElement('tr');
    tr.className = 'audit-row';
    tr.dataset.tool = tool;
    tr.dataset.decision = decision;
    tr.dataset.rule = rule;
    tr.dataset.ts = String(ts);
    if (requestId) tr.dataset.requestId = requestId;
    tr.setAttribute('@click', 'expanded = expanded === ' + idx + ' ? null : ' + idx);
    tr.setAttribute('x-show', FILTER_EXPR);

    var tdTs = mkCell(null, 'muted');
    var tsSpan = document.createElement('span');
    tsSpan.textContent = window.timeAgo(ts);
    tdTs.appendChild(tsSpan);
    tr.appendChild(tdTs);
    tr.appendChild(mkCell(tool));

    var tdDec = mkCell(null);
    var pillSpan = document.createElement('span');
    pillSpan.className = 'pill' + (
      decision === 'allow' || decision === 'deny' ? ' pill-' + decision :
      decision === 'approval' ? ' pill-info' :
      ''
    );
    pillSpan.textContent = decision;
    tdDec.appendChild(pillSpan);
    tr.appendChild(tdDec);

    tr.appendChild(mkCell(argvLen, 'muted'));

    var tdRule = mkCell(null);
    if (rule) tdRule.textContent = rule; else tdRule.appendChild(mkMutedDash());
    tr.appendChild(tdRule);

    var detail = document.createElement('tr');
    detail.className = 'audit-row-detail';
    detail.setAttribute('x-show', 'expanded === ' + idx);
    var dtd = document.createElement('td');
    dtd.colSpan = 5;
    var meta = document.createElement('div');
    meta.className = 'muted';
    meta.style.marginBottom = 'var(--gap-sm)';
    function appendKv(label, value) {
      if (meta.childNodes.length) meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(document.createTextNode(label + ': '));
      var c = document.createElement('code'); c.textContent = value; meta.appendChild(c);
    }
    appendKv('ts', isFinite(ts) ? new Date(ts).toISOString() : '');
    if (argvLen !== '') appendKv('argv_len', argvLen);
    if (requestId) appendKv('request_id', requestId);
    dtd.appendChild(meta);
    detail.appendChild(dtd);

    return [tr, detail];
  }
  function capRows(tbody, max) {
    var rows = tbody.querySelectorAll('tr.audit-row');
    while (rows.length > max) {
      var last = rows[rows.length - 1];
      var nextSib = last.nextElementSibling;
      last.parentNode.removeChild(last);
      if (nextSib && nextSib.classList.contains('audit-row-detail')) {
        nextSib.parentNode.removeChild(nextSib);
      }
      rows = tbody.querySelectorAll('tr.audit-row');
    }
  }

  window.auditPage = function auditPage(initialOldestTs) {
    return {
      expanded: null,
      filterTool: '', filterDecision: '', filterRule: '',
      liveCount: 0, liveOn: false,
      oldestTs: initialOldestTs,
      nextIdx: 0,
      init() {
        this.nextIdx = this.$root.querySelectorAll('tr.audit-row').length;
        this.connectSSE();
      },
      connectSSE() {
        try {
          var self = this;
          var es = new EventSource('/api/v1/audit/stream');
          es.onopen = function () { self.liveOn = true; };
          es.onerror = function () { self.liveOn = false; };
          es.onmessage = function (ev) {
            var e; try { e = JSON.parse(ev.data); } catch (_) { return; }
            if (!e || typeof e !== 'object') return;
            self.insertEntry(e, /*prepend=*/true);
            self.liveCount++;
          };
        } catch (err) { console.error('audit SSE connect failed', err); }
      },
      insertEntry(e, prepend) {
        var tbody = this.$refs.tbody;
        if (!tbody) return;
        var pair = buildRowPair(e, this.nextIdx++);
        if (prepend) {
          tbody.insertBefore(pair[1], tbody.firstChild);
          tbody.insertBefore(pair[0], tbody.firstChild);
        } else {
          tbody.appendChild(pair[0]);
          tbody.appendChild(pair[1]);
        }
        capRows(tbody, 1000);
      },
      async loadMore() {
        // NOTE: /api/v1/audit does not support cursor/offset pagination — it
        // always returns the latest N entries. This button reloads the same
        // window; existing rows are deduplicated before appending to prevent
        // duplicates if clicked more than once.
        try {
          var res = await window.cApi('GET', '/api/v1/audit?limit=100');
          var data = (res && res.data) || [];
          if (!Array.isArray(data) || data.length === 0) return;
          // Build a set of row keys already present in the table so we can
          // skip entries we already have.  Key = request_id if present,
          // otherwise ts + '|' + tool + '|' + decision + '|' + rule (best-effort dedup).
          var tbody = this.$refs.tbody;
          var existingKeys = new Set();
          if (tbody) {
            tbody.querySelectorAll('tr.audit-row').forEach(function (tr) {
              var rid = tr.dataset.requestId;
              if (rid) { existingKeys.add('rid:' + rid); }
              else { existingKeys.add('tsv:' + tr.dataset.ts + '|' + tr.dataset.tool + '|' + tr.dataset.decision + '|' + tr.dataset.rule); }
            });
          }
          var oldest = this.oldestTs;
          for (var i = 0; i < data.length; i++) {
            var e = data[i];
            var key = e.request_id
              ? 'rid:' + String(e.request_id)
              : 'tsv:' + String(e.ts) + '|' + String(e.tool || '') + '|' + String(e.decision || '') + '|' + String(e.rule || '');
            if (existingKeys.has(key)) continue;
            if (typeof e.ts === 'number' && (oldest === null || e.ts < oldest)) oldest = e.ts;
            this.insertEntry(e, /*prepend=*/false);
          }
          this.oldestTs = oldest;
        } catch (err) { console.error('audit reload failed', err); }
      },
    };
  };
})();
`;

export function renderAuditPage(view: AuditPageInput): string {
  const oldestTs = view.entries.length > 0
    ? Math.min(...view.entries.map((e) => e.ts))
    : 'null';
  const rowsHtml = view.entries.map((e, i) => renderRow(e, i)).join('\n');
  const emptyRow = view.entries.length === 0
    ? `<tr><td colspan="5" class="muted">no audit entries yet</td></tr>`
    : '';
  const toolOptions = renderToolOptions(view.tools);

  return `<style>${STYLES}</style>
<script>${LIVE_SCRIPT}</script>
<h2>audit feed</h2>
<p class="muted">last ${view.entries.length} entries · live updates via SSE · raw: <code>/api/v1/audit/stream</code></p>

<div x-data="auditPage(${oldestTs})" x-init="init()">
  <div class="audit-filter-bar">
    <select x-model="filterTool" aria-label="filter by tool">
      <option value="">all tools</option>
      ${toolOptions}
    </select>
    <select x-model="filterDecision" aria-label="filter by decision">
      <option value="">all decisions</option>
      <option value="allow">allow</option>
      <option value="deny">deny</option>
      <option value="approval">approval</option>
    </select>
    <input type="text" x-model="filterRule" placeholder="filter by rule..." aria-label="filter by rule id" />
    <span class="audit-live-badge" :class="{ 'audit-live-off': !liveOn }">
      <span x-text="liveOn ? '● live' : '○ offline'"></span>
      · <span x-text="liveCount"></span> new
    </span>
  </div>

  <table class="audit-table">
    <thead><tr>
      <th>time</th>
      <th>tool</th>
      <th>decision</th>
      <th>argc</th>
      <th>rule</th>
    </tr></thead>
    <tbody x-ref="tbody">${rowsHtml}${emptyRow}</tbody>
  </table>

  <div class="audit-load-more">
    <button class="ghost" @click="loadMore()" title="Reloads the latest 100 entries — duplicate rows are filtered out automatically">reload entries</button>
  </div>
</div>`;
}
