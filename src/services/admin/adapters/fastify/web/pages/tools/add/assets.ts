// Client-side assets for the "add tool" card on the tools dashboard.
//
// All tool data is entered by the operator into Alpine state and POSTed to the
// existing /api/v1/tools endpoint, which zod-validates server-side. No
// user-controlled value is ever interpolated into an HTML/JS string on the
// server — the form is static markup; values live only in Alpine reactive state.
//
// Scope: http, cli and mcp_proxy (via /api/v1/mcp-upstreams) runtime tools;
// cli_passthrough must go in the gateway YAML. Added tools persist via the
// runtime_tools table and survive restarts.

export const ADD_TOOL_STYLES: string = `
[x-cloak] { display: none !important; }
.tool-wizard { max-width: 52rem; }
.wizard-steps {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  list-style: none; gap: .4rem; margin: 0 0 1.15rem; padding: 0;
  font: 400 var(--fz-sm)/1.5 var(--font);
}
.wizard-steps li {
  display: flex; align-items: center; gap: .5rem; padding: .45rem .55rem;
  color: var(--fg-muted); border-top: 2px solid var(--border);
}
.wizard-steps li[aria-current="step"] { border-color: var(--accent); background: var(--accent-soft); color: var(--fg); }
.wizard-steps li span:first-child { color: var(--accent); }
.wizard-drivers, .add-tool-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap); }
.wizard-driver {
  display: flex; align-items: flex-start; gap: .65rem; min-height: 5rem;
  padding: .7rem; border: 1px solid var(--border-strong);
  background: var(--surface-2); cursor: pointer; font-size: var(--fz);
}
.wizard-driver:has(:checked) { border-color: var(--accent); background: var(--accent-soft); }
.wizard-driver strong, .wizard-driver small { display: block; }
.wizard-driver strong { color: var(--fg); }
.wizard-driver input { accent-color: var(--accent); }
.wizard-driver small { margin-top: .2rem; }
.add-tool-grid .full { grid-column: 1 / -1; }
.add-tool-grid .field { min-width: 0; margin-bottom: 0; }
.add-tool-grid .row input { flex: 1 1 10rem; width: auto; min-width: 0; }
.wizard-chips { margin-top: .45rem; }
.wizard-optional { margin-top: .9rem; padding: .65rem; border: 1px solid var(--border); }
.wizard-optional summary { cursor: pointer; color: var(--accent); }
.wizard-optional .row input { flex: 1 1 10rem; width: auto; min-width: 0; }
.param-row {
  display: grid; grid-template-columns: 1fr 1fr 1fr auto auto;
  gap: var(--gap-sm); align-items: end; margin: 0 0 var(--gap-sm);
}
.param-row label { min-width: 0; margin: 0; }
.param-row input:not([type=checkbox]), .param-row select { display: block; width: 100%; }
.param-row .req-cell { display: flex; align-items: center; gap: .25rem; min-height: 2rem; }
.wizard-review { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .45rem 1.1rem; }
.wizard-review dt { color: var(--fg-muted); }
.wizard-review dd { margin: 0; overflow-wrap: anywhere; }
.wizard-actions { display: flex; justify-content: flex-end; gap: .45rem; margin-top: 1rem; }
.wizard-error { color: var(--danger); overflow-wrap: anywhere; }
.runtime-tools { border-top: 1px solid var(--border); margin-top: 1.2rem; padding-top: .35rem; }
@media (max-width: 540px) {
  .wizard-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wizard-drivers, .add-tool-grid { grid-template-columns: minmax(0, 1fr); gap: .45rem; }
  .param-row { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: .5rem 0; border-bottom: 1px solid var(--border); }
}
.rt-tools-table { width: 100%; border-collapse: collapse; }
.rt-tools-table th { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border-strong); color: var(--fg-muted); font-weight: normal; font-size: var(--fz-sm); }
.rt-tools-table td { padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border); font-size: var(--fz-sm); }
.add-tool-msg { font-size: var(--fz-sm); }
.add-tool-msg:not(.wizard-error) { color: var(--success); }
.add-tool-msg:empty { display: none; }
`;

export const ADD_TOOL_ALPINE: string = `
document.addEventListener('alpine:init', () => {
  Alpine.data('addToolForm', () => ({
    steps: ['Driver', 'Details', 'Configuration', 'Review'],
    step: 0, formError: '',
    type: '',
    name: '', namespace: '', description: '',
    method: 'GET', url: '',
    command: '', timeoutMs: 30000,
    params: [], nextParamId: 0,
    argInput: '', args: [],
    envInput: '', envs: [],
    host: '', port: 8000, transport: 'streamable_http',
    authType: 'none',
    authToken: '', authUser: '', authPass: '', authHeaderName: '', authHeaderValue: '',
    msg: '', msgError: false, busy: false,
    runtimeTools: [],

    init() { this.refresh(); },

    addParam() { this.params.push({ _id: this.nextParamId++, name: '', in: 'query', required: false, default: '' }); },
    removeParam(i) { this.params.splice(i, 1); },
    addArg() { const v = this.argInput.trim(); if (v) { this.args.push(v); this.argInput = ''; } },
    removeArg(i) { this.args.splice(i, 1); },
    addEnv() { const v = this.envInput.trim(); if (v) { this.envs.push(v); this.envInput = ''; } },
    removeEnv(i) { this.envs.splice(i, 1); },

    get toolId() {
      if (this.type === 'mcp_proxy') return this.name.trim() || 'name';
      return (this.namespace.trim() || 'namespace') + '__' + (this.name.trim() || 'name');
    },

    goTo(step) {
      this.step = step;
      this.formError = '';
      this.$nextTick(() => this.$root.querySelectorAll('.tool-wizard > section')[step]?.querySelector('h3')?.focus());
    },

    back() {
      if (!this.busy && this.step > 0) this.goTo(this.step - 1);
    },

    advance() {
      if (this.busy) return;
      this.formError = this.validateStep();
      if (this.formError) return;
      if (this.step === this.steps.length - 1) return this.submit();
      if (this.step === 2 && this.type === 'cli') {
        this.addArg();
        this.addEnv();
      }
      this.goTo(this.step + 1);
    },

    validateStep() {
      if (this.step === 0 && !this.type) return 'Choose a driver to continue.';
      if (this.step === 1 && this.type === 'mcp_proxy') {
        return /^[a-z0-9][a-z0-9_-]*$/.test(this.name.trim()) ? '' : 'Name must be lowercase letters, digits, - or _.';
      }
      if (this.step === 1 && !(this.namespace.trim() && this.name.trim() && this.description.trim())) {
        return 'Enter a namespace, a name, and a description.';
      }
      if (this.step !== 2) return '';
      if (this.params.some(param => !param.name.trim())) return 'Name or remove each parameter in the optional settings.';
      if (this.type === 'mcp_proxy') {
        if (!this.host.trim() || /[\\s/:]/.test(this.host.trim())) return 'Enter a bare hostname (no scheme, port or path).';
        const port = Number(this.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a port between 1 and 65535.';
        return this.authError();
      }
      if (this.type === 'cli') {
        if (!/^[a-zA-Z0-9_-]+$/.test(this.command.trim())) return 'Enter a bare executable name, such as node.';
        const timeout = this.timeoutMs === '' || this.timeoutMs == null ? 30000 : Number(this.timeoutMs);
        if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) return 'Enter a timeout between 1,000 and 300,000 ms.';
        return '';
      }
      try {
        const url = new URL(this.url.trim().replace(/{[^{}]+}/g, '1'));
        if (!['http:', 'https:'].includes(url.protocol)) return 'Enter an HTTP or HTTPS endpoint URL.';
      } catch { return 'Enter an HTTP or HTTPS endpoint URL.'; }
      return this.authError();
    },

    authError() {
      const refs = {
        none: [],
        bearer: [this.authToken],
        basic: [this.authUser, this.authPass],
        header: [this.authHeaderValue],
      }[this.authType];
      if (this.authType === 'header' && !this.authHeaderName.trim()) return 'Enter the header name.';
      if (refs.some(ref => !/^(env:|vault:).+/.test(ref.trim()))) return 'Enter an env: or vault: reference for each credential.';
      return '';
    },

    _auth() {
      if (this.authType === 'bearer') return { type: 'bearer', token: { from: this.authToken.trim() } };
      if (this.authType === 'basic') return { type: 'basic', username: { from: this.authUser.trim() }, password: { from: this.authPass.trim() } };
      if (this.authType === 'header') return { type: 'header', name: this.authHeaderName.trim(), value: { from: this.authHeaderValue.trim() } };
      return { type: 'none' };
    },

    _buildConfig() {
      if (this.type === 'mcp_proxy') {
        const cfg = { type: 'mcp_proxy', name: this.name.trim(), service_dns: this.host.trim(), port: Number(this.port), transport: this.transport, auth: this._auth() };
        if (this.description.trim()) cfg.description = this.description.trim();
        return cfg;
      }
      const params = this.params
        .filter(p => p.name.trim())
        .map(p => {
          const o = { name: p.name.trim(), in: p.in, required: !!p.required };
          if (p.default && p.default.trim()) o.default = p.default.trim();
          return o;
        });
      if (this.type === 'cli') {
        return {
          type: 'cli',
          name: this.name.trim(),
          namespace: this.namespace.trim(),
          description: this.description.trim(),
          command: this.command.trim(),
          args: [...this.args],
          params,
          timeout_ms: Number(this.timeoutMs) || 30000,
          env: [...this.envs],
          auth: 'none',
        };
      }
      let auth = { type: 'none' };
      if (this.authType === 'bearer') auth = { type: 'bearer', token: { from: this.authToken.trim() } };
      else if (this.authType === 'basic') auth = { type: 'basic', username: { from: this.authUser.trim() }, password: { from: this.authPass.trim() } };
      else if (this.authType === 'header') auth = { type: 'header', name: this.authHeaderName.trim(), value: { from: this.authHeaderValue.trim() } };
      return {
        type: 'http',
        name: this.name.trim(),
        namespace: this.namespace.trim(),
        description: this.description.trim(),
        method: this.method,
        url: this.url.trim(),
        params,
        auth,
      };
    },

    async submit() {
      this.busy = true; this.msg = ''; this.msgError = false;
      const id = this.toolId;
      try {
        const res = await fetch(this.type === 'mcp_proxy' ? '/api/v1/mcp-upstreams' : '/api/v1/tools', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this._buildConfig()),
        });
        if (res.status === 201) {
          this.msg = 'Added ' + id + '.';
          this._reset();
          this.goTo(0);
          await this.refresh();
        } else {
          const j = await res.json().catch(() => ({}));
          if (j && j.error && Array.isArray(j.error.details) && j.error.details.length) {
            const d = j.error.details[0];
            this.formError = 'Invalid configuration: ' + (d.path ? d.path.join('.') + ': ' : '') + d.message;
          } else {
            this.formError = (j && j.error && j.error.message) || ('HTTP ' + res.status);
          }
        }
      } catch (e) {
        this.formError = 'Could not save tool: ' + (e && e.message ? e.message : String(e));
      } finally {
        this.busy = false;
      }
    },

    _reset() {
      this.type = ''; this.method = 'GET'; this.timeoutMs = 30000;
      this.argInput = ''; this.envInput = '';
      this.name = ''; this.namespace = ''; this.description = '';
      this.url = ''; this.command = '';
      this.params = []; this.args = []; this.envs = [];
      this.authType = 'none'; this.authToken = ''; this.authUser = ''; this.authPass = '';
      this.authHeaderName = ''; this.authHeaderValue = '';
      this.host = ''; this.port = 8000; this.transport = 'streamable_http';
    },

    async refresh() {
      try {
        // source=runtime filters server-side so UI-added tools are never hidden
        // behind file tools on a paginated first page.
        const res = await fetch('/api/v1/tools?source=runtime&per_page=100', { headers: { 'accept': 'application/json' } });
        if (!res.ok) return;
        const j = await res.json();
        const data = (j && Array.isArray(j.data)) ? j.data : [];
        this.runtimeTools = data
          .map(t => ({ id: t.id, driver: t.driver }))
          .sort((a, b) => a.id.localeCompare(b.id));
        const up = await fetch('/api/v1/mcp-upstreams', { headers: { 'accept': 'application/json' } });
        if (up.ok) {
          const uj = await up.json();
          const ups = (uj && Array.isArray(uj.data) ? uj.data : []).filter(u => u.source === 'runtime')
            .map(u => ({ id: u.name, driver: 'mcp_proxy' }));
          this.runtimeTools = [...ups, ...this.runtimeTools];
        }
      } catch { /* leave list as-is on transient error */ }
    },

    async removeTool(id) {
      if (!confirm('Delete runtime tool ' + id + '?')) return;
      try {
        const isUp = (this.runtimeTools.find(t => t.id === id) || {}).driver === 'mcp_proxy';
        const res = await fetch((isUp ? '/api/v1/mcp-upstreams/' : '/api/v1/tools/') + encodeURIComponent(id), { method: 'DELETE' });
        if (res.status === 204) { this.msg = 'deleted ' + id; this.msgError = false; await this.refresh(); }
        else { const j = await res.json().catch(() => ({})); this.msg = (j && j.error && j.error.message) || ('HTTP ' + res.status); this.msgError = true; }
      } catch (e) {
        this.msg = 'failed: ' + (e && e.message ? e.message : String(e)); this.msgError = true;
      }
    },
  }));
});
`;
