// Tool detail page — interactive Alpine.js policy editor.
//
// Renders the inner <main> body for /admin/tools/:name. Caller wraps with
// HEAD/NAV/FOOT. All server-side interpolation goes through escapeHtml; no
// user-controlled data is ever embedded into JS expressions or x-data
// attributes — the Alpine component is bootstrapped from a JSON blob in a
// data-* attribute and read via $el.dataset.policy.
//
// Inline CSS and the Alpine component body live in tool-detail-assets.ts to
// keep this file focused on HTML composition.

import { escapeHtml, pill, kpi, spark } from '../components.js';
import { TOOL_DETAIL_STYLES, TOOL_DETAIL_ALPINE } from './tool-detail-assets.js';

export interface ToolDetailViewInput {
  tool: string;
  view: {
    tool: string;
    file_policy: unknown;
    override: unknown;
    effective: unknown;
    profile_overrides?: string[];
  };
  /** All profile names, the selected scope (null = all profiles) and its override. */
  profiles?: string[];
  profile?: string | null;
  profile_override?: unknown;
  metric: {
    total: number;
    allow: number;
    deny: number;
    rule_denies: Record<string, number>;
    buckets_1h: number[];
  } | null;
  recent: Array<{
    ts: number;
    tool: string;
    decision: 'allow' | 'deny' | 'approval';
    rule?: string;
    argv_len?: number;
  }>;
}

function renderStatusStrip(view: ToolDetailViewInput): string {
  const v = view.view;
  const scoped = view.profile ?? null;
  const source = scoped
    ? (view.profile_override ? 'profile override' : (v.override ? 'inherited: all-profiles override' : (v.file_policy ? 'inherited: file policy' : 'none')))
    : (v.override ? 'override' : (v.file_policy ? 'file' : 'none'));
  const variant = source.includes('override') && !source.startsWith('inherited') ? 'override' : (source === 'none' ? 'muted' : 'file');
  return `<div class="row" style="justify-content:space-between; align-items:flex-end; margin-bottom:var(--gap)">
  <div>
    <h2 style="margin:0">${escapeHtml(view.tool)}</h2>
    <p class="muted" style="margin:0.25rem 0 0">source: ${pill(source, variant)}</p>
  </div>
  <div><a href="/admin/">← back to tools</a></div>
</div>`;
}

function renderScopeSelector(view: ToolDetailViewInput): string {
  const profiles = view.profiles ?? [];
  const withOverride = new Set(view.view.profile_overrides ?? []);
  const base = `/admin/tools/${encodeURIComponent(view.tool)}`;
  const chip = (label: string, href: string, active: boolean, marker: boolean) =>
    `<a href="${escapeHtml(href)}" class="scope-chip${active ? ' active' : ''}">${escapeHtml(label)}${marker ? ' <span class="scope-dot" title="has its own override"></span>' : ''}</a>`;
  const chips = [chip('All profiles', base, !view.profile, !!view.view.override)]
    .concat(profiles.map(p => chip(p, `${base}?profile=${encodeURIComponent(p)}`, view.profile === p, withOverride.has(p))))
    .join('');
  const hint = view.profile
    ? (view.profile_override
      ? `Profile <strong>${escapeHtml(view.profile)}</strong> has its own policy. Only callers on this profile are affected.`
      : `Profile <strong>${escapeHtml(view.profile)}</strong> has no policy of its own and inherits the ${view.view.override ? 'all-profiles override' : 'file policy'}. Save to give it its own.`)
    : `This is the default for every profile that has no override of its own. Order of precedence: profile override, then this default, then the file policy.`;
  return `<div class="scope-box">
  <span class="field-label">Edit policy for</span>
  <div class="scope-chips">${chips}</div>
  <p class="muted" style="margin:0.4rem 0 0; font-size:var(--fz-sm)">${hint}</p>
</div>`;
}

function renderMetricsStrip(view: ToolDetailViewInput): string {
  const m = view.metric;
  if (!m) {
    return `<div class="row" style="gap:var(--gap); margin-bottom:var(--gap)">${kpi('total', 0)}${kpi('allow', 0)}${kpi('deny', 0)}${kpi('deny rate', '—')}</div>`;
  }
  const denyRate = m.total > 0 ? `${((m.deny / m.total) * 100).toFixed(1)}%` : '—';
  const sparkHtml = spark(m.buckets_1h ?? [], { width: 24 });
  const cells = [
    kpi('total', m.total),
    kpi('allow', m.allow),
    kpi('deny', m.deny),
    kpi('deny rate', denyRate),
  ].join('');
  return `<div class="row" style="gap:var(--gap); margin-bottom:var(--gap); align-items:stretch">${cells}<div class="kpi" style="min-width:10rem"><span class="kpi-label">24h</span><span style="font-size:1.3rem; display:block">${sparkHtml}</span></div></div>`;
}

function tagInputFor(field: string, label: string, placeholder: string): string {
  const key = `in_${field}`;
  return `<div class="field-group">
  <span class="field-label">${escapeHtml(label)}</span>
  <div class="tag-input-wrap">
    <template x-for="(t, i) in policy.${field}" :key="i">
      <span class="tag-chip"><span x-text="t"></span><button type="button" @click="removeTag('${field}', i)" title="remove">×</button></span>
    </template>
    <input type="text" placeholder="${escapeHtml(placeholder)}" x-model="inputs.${key}" @keydown="handleTagKey($event, '${field}', '${key}')" />
  </div>
</div>`;
}

function regexTagInputFor(field: string, label: string): string {
  const key = `in_${field}`;
  return `<div class="field-group">
  <span class="field-label">${escapeHtml(label)}</span>
  <div class="tag-input-wrap">
    <template x-for="(t, i) in policy.${field}" :key="i">
      <span class="tag-chip">
        <span x-text="t"></span>
        <span :class="isValidRegex(t) ? 'regex-ok' : 'regex-bad'" x-text="isValidRegex(t) ? '✓' : '✗'"></span>
        <button type="button" @click="removeTag('${field}', i)" title="remove">×</button>
      </span>
    </template>
    <input type="text" placeholder="regex pattern" x-model="inputs.${key}" @keydown="handleTagKey($event, '${field}', '${key}')" />
  </div>
</div>`;
}

function denySubcommandsField(): string {
  const key = 'in_deny_sc';
  return `<div class="field-group">
  <span class="field-label">deny_subcommands (toggle approval per-entry)</span>
  <div class="tag-input-wrap">
    <template x-for="(e, i) in policy.deny_sc_entries" :key="i">
      <span class="tag-chip">
        <span x-text="e.value"></span>
        <label class="approval-toggle"><input type="checkbox" x-model="e.approval" /> approval</label>
        <button type="button" @click="removeDenyEntry(i)" title="remove">×</button>
      </span>
    </template>
    <input type="text" placeholder="subcommand name" x-model="inputs.${key}" @keydown="handleDenyEntryKey($event, '${key}')" />
  </div>
</div>`;
}

function pathGroupField(field: string, label: string): string {
  return `<div class="field-group">
  <span class="field-label">${escapeHtml(label)}</span>
  <template x-for="(grp, gi) in policy.${field}" :key="gi">
    <div class="group-row">
      <div class="grow tag-input-wrap">
        <template x-for="(t, ti) in grp" :key="ti">
          <span class="tag-chip"><span x-text="t"></span><button type="button" @click="removeGroupTag('${field}', gi, ti)" title="remove">×</button></span>
        </template>
        <input type="text" placeholder="segment" x-model="inputs['${field}_g_' + gi]" @keydown="handleGroupTagKey($event, '${field}', gi, '${field}_g_' + gi)" />
      </div>
      <button type="button" class="ghost" @click="removeGroup('${field}', gi)" title="remove group">× group</button>
    </div>
  </template>
  <button type="button" @click="addGroup('${field}')">+ add group</button>
</div>`;
}

function denyPathsField(): string {
  return `<div class="field-group">
  <span class="field-label">deny_subcommand_paths (toggle approval per-row)</span>
  <template x-for="(e, gi) in policy.deny_sp_entries" :key="gi">
    <div class="group-row">
      <div class="grow tag-input-wrap">
        <template x-for="(t, ti) in e.path" :key="ti">
          <span class="tag-chip"><span x-text="t"></span><button type="button" @click="removeDenyPathTag(gi, ti)" title="remove">×</button></span>
        </template>
        <input type="text" placeholder="segment" x-model="inputs['deny_sp_g_' + gi]" @keydown="handleDenyPathTagKey($event, gi, 'deny_sp_g_' + gi)" />
      </div>
      <label class="approval-toggle"><input type="checkbox" x-model="e.approval" /> approval</label>
      <button type="button" class="ghost" @click="removeDenyPath(gi)" title="remove row">× row</button>
    </div>
  </template>
  <button type="button" @click="addDenyPath()">+ add path</button>
</div>`;
}

function renderEditorColumn(): string {
  return `<div>
${tagInputFor('allow_subcommands', 'allow_subcommands', 'subcommand name')}
${denySubcommandsField()}
${pathGroupField('allow_subcommand_paths', 'allow_subcommand_paths')}
${denyPathsField()}
${tagInputFor('deny_args', 'deny_args (substring deny on any argv element)', 'substring')}
${regexTagInputFor('deny_args_regex', 'deny_args_regex (per-element regex)')}
${regexTagInputFor('deny_argv_regex', 'deny_argv_regex (against joined argv)')}
${tagInputFor('require_args', 'require_args', '--flag or --flag=')}
${pathGroupField('require_any_of', 'require_any_of (OR-groups)')}
<div class="field-group">
  <span class="field-label">max_args</span>
  <input type="number" min="1" max="10000" x-model.number="policy.max_args" />
</div>
<div class="field-group">
  <span class="field-label">on_violation</span>
  <label class="approval-toggle"><input type="radio" name="onv" value="deny" x-model="policy.on_violation" /> deny</label>
  <label class="approval-toggle" style="margin-left:var(--gap-sm)"><input type="radio" name="onv" value="approval" x-model="policy.on_violation" /> approval</label>
</div>
<div class="field-group">
  <label class="approval-toggle"><input type="checkbox" x-model="policy.audit" /> audit (log accepted invocations)</label>
</div>
<div class="action-bar">
  <button type="button" class="primary" @click="applyOverride()" x-text="scopeProfile ? 'save for ' + scopeProfile : 'save for all profiles'"></button>
  <button type="button" @click="clearOverride()" x-text="scopeProfile ? 'remove (inherit)' : 'reset to file policy'"></button>
  <button type="button" @click="exportJson()">export JSON</button>
  <label class="approval-toggle" style="cursor:pointer">import JSON <input type="file" accept=".json,application/json" @change="importJson($event)" style="display:none" /></label>
  <span class="action-msg" :style="msgError ? 'color:var(--danger)' : 'color:var(--success)'" x-text="msg"></span>
</div>
</div>`;
}

function renderPreviewColumn(): string {
  return `<div>
<div class="row" style="justify-content:space-between; margin-bottom:var(--gap-sm)">
  <strong style="color:var(--fg-muted); font-size:var(--fz-sm)">JSON preview</strong>
  <label class="approval-toggle"><input type="checkbox" x-model="showDiff" /> show diff vs inherited policy</label>
</div>
<pre class="json-preview" x-text="jsonPreview"></pre>
<div x-show="showDiff" class="diff-grid">
  <div>
    <span class="field-label">inherited policy</span>
    <pre class="json-preview" x-text="filePolicyJson"></pre>
  </div>
  <div>
    <span class="field-label">editor (current)</span>
    <pre class="json-preview" x-text="jsonPreview"></pre>
  </div>
</div>
</div>`;
}

function renderDryRunSection(): string {
  return `<h3 style="margin-top:1.5rem">dry-run argv</h3>
<div class="row" style="align-items:flex-start">
  <input type="text" class="grow" x-model="dryArgv" placeholder='git commit -m foo  OR  ["get","pods","-n","sentinel"]' style="font-family:var(--font)" />
  <button type="button" @click="runDryRun()">evaluate</button>
</div>
<div x-show="dryError" class="muted" style="color:var(--danger)" x-text="dryError"></div>
<div x-show="dryResult" style="margin-top:var(--gap-sm)">
  <span class="pill" :class="dryResult && dryResult.decision === 'allow' ? 'pill-allow' : (dryResult && dryResult.decision === 'deny' ? 'pill-deny' : 'pill-warn')" x-text="dryResult && (dryResult.decision || 'allow')"></span>
  <span class="muted" x-show="dryResult && dryResult.rule">rule: <code x-text="dryResult && dryResult.rule"></code></span>
  <span class="muted" x-show="dryResult && dryResult.matched"> matched: <code x-text="dryResult && dryResult.matched"></code></span>
  <span class="muted" x-show="dryResult && dryResult.message"> · <span x-text="dryResult && dryResult.message"></span></span>
</div>`;
}

function renderRecentActivity(view: ToolDetailViewInput): string {
  const rows = view.recent.slice(0, 50).map((e) => {
    const ts = Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : '—';
    return `<tr><td class="muted">${escapeHtml(ts)}</td><td>${escapeHtml(String(e.argv_len ?? ''))}</td><td>${pill(e.decision, e.decision)}</td><td>${escapeHtml(e.rule ?? '')}</td></tr>`;
  }).join('');
  const body = view.recent.length === 0
    ? `<p class="muted">no activity</p>`
    : `<table><thead><tr><th>ts</th><th>argc</th><th>decision</th><th>rule</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<details style="margin-top:1.5rem"><summary>recent activity (${view.recent.length})</summary>${body}</details>`;
}

export function renderToolDetail(view: ToolDetailViewInput): string {
  // Bootstrap data: serialize once on the server, embed as data-* attributes.
  // x-data uses a constant reference; user data never reaches a JS expression.
  const activePolicyJson = view.profile
    ? JSON.stringify(view.profile_override ?? view.view.effective ?? {})
    : (view.view.override ? JSON.stringify(view.view.override) : JSON.stringify(view.view.effective ?? {}));
  // Baseline for the diff: what this scope would inherit if it had no override.
  const filePolicyJson = JSON.stringify((view.profile ? view.view.effective : view.view.file_policy) ?? null);

  return `<style>${TOOL_DETAIL_STYLES}</style>
${renderStatusStrip(view)}
${renderScopeSelector(view)}
${renderMetricsStrip(view)}

<div x-data="policyEditor"
     data-tool="${escapeHtml(view.tool)}"
     data-profile="${escapeHtml(view.profile ?? '')}"
     data-policy="${escapeHtml(activePolicyJson)}"
     data-file-policy="${escapeHtml(filePolicyJson)}">
  <div class="editor-grid">
    ${renderEditorColumn()}
    ${renderPreviewColumn()}
  </div>
  ${renderDryRunSection()}
</div>

${renderRecentActivity(view)}

<script>${TOOL_DETAIL_ALPINE}</script>`;
}
