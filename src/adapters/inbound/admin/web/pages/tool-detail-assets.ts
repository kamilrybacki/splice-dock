// Inline CSS + Alpine.js component body for the tool detail policy editor.
//
// Kept in a separate module so tool-detail.ts stays focused on HTML
// composition. These strings are embedded verbatim inside <style>/<script>
// blocks; no server-side interpolation happens here, so they are static.

export const TOOL_DETAIL_STYLES: string = `
.editor-grid { display: grid; grid-template-columns: 1fr; gap: var(--gap); }
@media (min-width: 1024px) { .editor-grid { grid-template-columns: 1fr 1fr; } }
.json-preview { background: var(--surface-2); border: 1px solid var(--border); padding: var(--gap); border-radius: var(--radius); overflow-x: auto; font-size: var(--fz-sm); white-space: pre; }
.field-group { margin-bottom: var(--gap); }
.field-label { color: var(--fg-muted); font-size: var(--fz-sm); margin-bottom: 0.25rem; display: block; }
.action-bar { display: flex; gap: var(--gap-sm); flex-wrap: wrap; padding: var(--gap) 0; border-top: 1px solid var(--border); margin-top: var(--gap); position: sticky; bottom: 0; background: var(--bg); }
.tag-chip { display: inline-flex; gap: 0.25rem; align-items: center; padding: 0.05rem 0.4rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); font-size: var(--fz-sm); }
.tag-chip button { background: transparent; border: none; color: var(--fg-muted); padding: 0 0.2rem; cursor: pointer; }
.tag-chip button:hover { color: var(--danger); }
.tag-input-wrap { display: flex; flex-wrap: wrap; gap: 0.25rem; padding: 0.25rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); align-items: center; }
.tag-input-wrap input { border: none; background: transparent; flex: 1 1 6rem; padding: 0.2rem; min-width: 6rem; }
.tag-input-wrap input:focus { outline: none; }
.group-row { display: flex; gap: var(--gap-sm); align-items: flex-start; margin-bottom: 0.4rem; }
.group-row .grow { flex: 1 1 auto; }
.regex-ok { color: var(--success); margin-left: 0.25rem; }
.regex-bad { color: var(--danger); margin-left: 0.25rem; }
.approval-toggle { font-size: var(--fz-sm); color: var(--fg-muted); display: inline-flex; gap: 0.25rem; align-items: center; }
.approval-toggle input { transform: scale(0.85); margin: 0; }
.diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap-sm); margin-top: var(--gap-sm); }
.scope-box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: var(--gap); margin-bottom: var(--gap); }
.scope-chips { display: flex; flex-wrap: wrap; gap: var(--gap-sm); }
.scope-chip { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--fg); text-decoration: none; font-size: var(--fz-sm); }
.scope-chip.active { border-color: var(--accent, var(--fg)); font-weight: 600; }
.scope-dot { display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--accent, var(--success)); margin-left: 0.2rem; }
.action-msg { font-size: var(--fz-sm); margin-left: var(--gap-sm); }
`;

// Alpine component body. State + methods are documented in tool-detail.ts.
// The component bootstraps from data-* attributes on its root element:
//   data-tool         the tool name (used in API URLs)
//   data-policy       JSON of the active policy (override ?? effective ?? {})
//   data-file-policy  JSON of the file policy (or null)
export const TOOL_DETAIL_ALPINE: string = `
document.addEventListener('alpine:init', () => {
  Alpine.data('policyEditor', () => ({
    policy: {
      allow_subcommands: [], deny_sc_entries: [],
      allow_subcommand_paths: [], deny_sp_entries: [],
      deny_args: [], deny_args_regex: [], deny_argv_regex: [],
      require_args: [], require_any_of: [],
      max_args: 256, on_violation: 'deny', audit: false,
    },
    scopeProfile: '', inputs: {}, msg: '', msgError: false, showDiff: false,
    filePolicyJson: '', dryArgv: '', dryResult: null, dryError: '',
    _loadFrom(p) {
      const denySC = Array.isArray(p.deny_subcommands) ? p.deny_subcommands : [];
      const approvalSC = new Set(Array.isArray(p.approval_subcommands) ? p.approval_subcommands : []);
      const denySP = Array.isArray(p.deny_subcommand_paths) ? p.deny_subcommand_paths : [];
      const approvalSP = Array.isArray(p.approval_subcommand_paths) ? p.approval_subcommand_paths : [];
      const approvalSPKeys = new Set(approvalSP.map(x => JSON.stringify(x)));
      this.policy.allow_subcommands = Array.isArray(p.allow_subcommands) ? [...p.allow_subcommands] : [];
      this.policy.deny_sc_entries = denySC.map(v => ({ value: String(v), approval: approvalSC.has(v) }));
      this.policy.allow_subcommand_paths = Array.isArray(p.allow_subcommand_paths)
        ? p.allow_subcommand_paths.map(s => Array.isArray(s) ? [...s] : []) : [];
      this.policy.deny_sp_entries = denySP.map(x => ({
        path: Array.isArray(x) ? [...x] : [],
        approval: approvalSPKeys.has(JSON.stringify(x)),
      }));
      this.policy.deny_args = Array.isArray(p.deny_args) ? [...p.deny_args] : [];
      this.policy.deny_args_regex = Array.isArray(p.deny_args_regex) ? [...p.deny_args_regex] : [];
      this.policy.deny_argv_regex = Array.isArray(p.deny_argv_regex) ? [...p.deny_argv_regex] : [];
      this.policy.require_args = Array.isArray(p.require_args) ? [...p.require_args] : [];
      this.policy.require_any_of = Array.isArray(p.require_any_of)
        ? p.require_any_of.map(g => Array.isArray(g) ? [...g] : []) : [];
      const n = p.max_args;
      this.policy.max_args = Number.isFinite(n) && n >= 1 ? n : 256;
      this.policy.on_violation = p.on_violation === 'approval' ? 'approval' : 'deny';
      this.policy.audit = !!p.audit;
    },
    policyUrl(suffix) {
      const base = '/api/v1/policies/' + encodeURIComponent(this.$el.dataset.tool) + (suffix || '');
      return this.scopeProfile ? base + '?profile=' + encodeURIComponent(this.scopeProfile) : base;
    },
    init() {
      this.scopeProfile = this.$el.dataset.profile || '';
      try {
        const raw = this.$el.dataset.policy || '{}';
        const fileRaw = this.$el.dataset.filePolicy || 'null';
        this.filePolicyJson = JSON.stringify(JSON.parse(fileRaw) || {}, null, 2);
        const p = JSON.parse(raw) || {};
        this._loadFrom(p);
      } catch (e) {
        this.msg = 'failed to parse server policy: ' + (e && e.message ? e.message : String(e));
        this.msgError = true;
      }
    },
    toApiPayload() {
      const dE = this.policy.deny_sc_entries.filter(e => e.value);
      const dSP = this.policy.deny_sp_entries.filter(e => Array.isArray(e.path) && e.path.length > 0);
      const _n = this.policy.max_args;
      const out = {
        max_args: Number.isFinite(_n) && _n >= 1 ? _n : 256,
        on_violation: this.policy.on_violation,
        audit: !!this.policy.audit,
      };
      if (this.policy.allow_subcommands.length) out.allow_subcommands = [...this.policy.allow_subcommands];
      const denySC = dE.map(e => e.value);
      const apprSC = dE.filter(e => e.approval).map(e => e.value);
      if (denySC.length) out.deny_subcommands = denySC;
      if (apprSC.length) out.approval_subcommands = apprSC;
      if (this.policy.allow_subcommand_paths.length) out.allow_subcommand_paths = this.policy.allow_subcommand_paths.map(p => [...p]);
      const denySP = dSP.map(e => [...e.path]);
      const apprSP = dSP.filter(e => e.approval).map(e => [...e.path]);
      if (denySP.length) out.deny_subcommand_paths = denySP;
      if (apprSP.length) out.approval_subcommand_paths = apprSP;
      if (this.policy.deny_args.length) out.deny_args = [...this.policy.deny_args];
      if (this.policy.deny_args_regex.length) out.deny_args_regex = [...this.policy.deny_args_regex];
      if (this.policy.deny_argv_regex.length) out.deny_argv_regex = [...this.policy.deny_argv_regex];
      if (this.policy.require_args.length) out.require_args = [...this.policy.require_args];
      if (this.policy.require_any_of.length) out.require_any_of = this.policy.require_any_of.map(g => [...g]);
      return out;
    },
    get jsonPreview() { return JSON.stringify(this.toApiPayload(), null, 2); },
    addTag(field, key) {
      const v = (this.inputs[key] || '').trim(); if (!v) return;
      const a = this.policy[field]; if (!a.includes(v)) a.push(v); this.inputs[key] = '';
    },
    removeTag(field, i) { this.policy[field].splice(i, 1); },
    handleTagKey(e, field, key) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addTag(field, key); }
      else if (e.key === 'Backspace' && !this.inputs[key] && this.policy[field].length) this.policy[field].pop();
    },
    addDenyEntry(key) {
      const v = (this.inputs[key] || '').trim(); if (!v) return;
      if (!this.policy.deny_sc_entries.some(e => e.value === v)) this.policy.deny_sc_entries.push({ value: v, approval: false });
      this.inputs[key] = '';
    },
    removeDenyEntry(i) { this.policy.deny_sc_entries.splice(i, 1); },
    handleDenyEntryKey(e, key) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addDenyEntry(key); } },
    addGroup(field) { this.policy[field].push([]); },
    removeGroup(field, i) { this.policy[field].splice(i, 1); },
    addGroupTag(field, gi, key) {
      const v = (this.inputs[key] || '').trim(); if (!v) return;
      const g = this.policy[field][gi]; if (g && !g.includes(v)) g.push(v); this.inputs[key] = '';
    },
    removeGroupTag(field, gi, ti) { this.policy[field][gi].splice(ti, 1); },
    handleGroupTagKey(e, field, gi, key) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addGroupTag(field, gi, key); } },
    addDenyPath() { this.policy.deny_sp_entries.push({ path: [], approval: false }); },
    removeDenyPath(i) { this.policy.deny_sp_entries.splice(i, 1); },
    addDenyPathTag(gi, key) {
      const v = (this.inputs[key] || '').trim(); if (!v) return;
      const e = this.policy.deny_sp_entries[gi]; if (e && !e.path.includes(v)) e.path.push(v); this.inputs[key] = '';
    },
    removeDenyPathTag(gi, ti) { this.policy.deny_sp_entries[gi].path.splice(ti, 1); },
    handleDenyPathTagKey(e, gi, key) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addDenyPathTag(gi, key); } },
    isValidRegex(pat) { try { new RegExp(pat); return true; } catch (_) { return false; } },
    setMsg(text, isError) { this.msg = text || ''; this.msgError = !!isError; },
    async applyOverride() {
      this.setMsg('applying…', false);
      const tool = this.$el.dataset.tool;
      try {
        const res = await fetch(this.policyUrl(), {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ policy: this.toApiPayload() }),
        });
        if (!res.ok) {
          let detail = '';
          try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
          this.setMsg('failed: ' + (detail || ('HTTP ' + res.status)), true); return;
        }
        this.setMsg(this.scopeProfile ? 'saved for ' + this.scopeProfile : 'saved for all profiles', false);
        setTimeout(() => location.reload(), 600);
      } catch (e) { this.setMsg('failed: ' + (e && e.message ? e.message : String(e)), true); }
    },
    async clearOverride() {
      const tool = this.$el.dataset.tool;
      this.setMsg('clearing…', false);
      try {
        const res = await fetch(this.policyUrl(), { method: 'DELETE' });
        if (!res.ok) { this.setMsg('failed: HTTP ' + res.status, true); return; }
        this.setMsg('override cleared', false);
        setTimeout(() => location.reload(), 600);
      } catch (e) { this.setMsg('failed: ' + (e && e.message ? e.message : String(e)), true); }
    },
    exportJson() {
      const blob = new Blob([JSON.stringify(this.toApiPayload(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (this.$el.dataset.tool || 'policy') + '-policy.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    importJson(ev) {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          this._loadFrom(data); this.setMsg('imported', false);
        } catch (e) { this.setMsg('invalid JSON: ' + (e && e.message ? e.message : String(e)), true); }
      };
      reader.readAsText(f); ev.target.value = '';
    },
    async runDryRun() {
      this.dryError = ''; this.dryResult = null;
      const tool = this.$el.dataset.tool;
      const text = (this.dryArgv || '').trim();
      if (!text) { this.dryError = 'enter argv'; return; }
      let argv;
      if (text.startsWith('[')) {
        try { argv = JSON.parse(text); }
        catch (e) { this.dryError = 'invalid JSON: ' + (e && e.message ? e.message : String(e)); return; }
      } else { argv = text.split(/\\s+/); }
      if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) {
        this.dryError = 'argv must be an array of strings'; return;
      }
      try {
        const res = await fetch(this.policyUrl('/dry-run'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ argv, policy: this.toApiPayload() }),
        });
        const j = await res.json();
        if (!res.ok) { this.dryError = (j && j.error && j.error.message) || ('HTTP ' + res.status); return; }
        this.dryResult = j.data || j;
      } catch (e) { this.dryError = 'failed: ' + (e && e.message ? e.message : String(e)); }
    },
  }));
});
`;
