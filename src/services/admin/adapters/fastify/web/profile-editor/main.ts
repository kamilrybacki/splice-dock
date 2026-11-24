// Browser entrypoint for the profiles catalog. esbuild bundles this module as
// an IIFE; CodeMirror and its YAML mode are included in that bundle (no CDN).

import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  StreamLanguage,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';

interface ProfileSummary {
  name: string;
  tools: string[];
  credentials: unknown;
  enable_code_mode: boolean;
  source: string;
  revision?: number;
  updated_at?: number;
  updated_by?: string | null;
}

interface ManifestData {
  name: string;
  manifest: string;
  revision: number;
  updated_at: number;
  updated_by: string | null;
}

interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const EDITOR_THEME = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 'var(--fz-sm)',
  },
  '.cm-content': {
    caretColor: 'var(--fg)',
    padding: '0.6rem 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--fg)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg-faint)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(96, 165, 250, 0.06)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--fg-muted)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-2)',
    borderColor: 'var(--border-strong)',
    color: 'var(--fg-muted)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(250, 204, 21, 0.2)',
    outline: '1px solid var(--warn)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-soft)',
  },
}, { dark: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseManifestData(value: unknown): ManifestData {
  if (!isRecord(value)
    || typeof value['name'] !== 'string'
    || typeof value['manifest'] !== 'string'
    || !finiteNumber(value['revision'])
    || !finiteNumber(value['updated_at'])) {
    throw new Error('server returned an invalid profile manifest response');
  }
  const updatedBy = value['updated_by'];
  return {
    name: value['name'],
    manifest: value['manifest'],
    revision: value['revision'],
    updated_at: value['updated_at'],
    updated_by: typeof updatedBy === 'string' ? updatedBy : null,
  };
}

function parseProfileSummary(value: unknown): ProfileSummary {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    throw new Error('server returned an invalid profile catalog response');
  }
  const tools = value['tools'];
  const revision = value['revision'];
  const updatedAt = value['updated_at'];
  const updatedBy = value['updated_by'];
  return {
    name: value['name'],
    tools: Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : [],
    credentials: value['credentials'],
    enable_code_mode: value['enable_code_mode'] === true,
    source: typeof value['source'] === 'string' ? value['source'] : 'unknown',
    revision: finiteNumber(revision) ? revision : undefined,
    updated_at: finiteNumber(updatedAt) ? updatedAt : undefined,
    updated_by: typeof updatedBy === 'string' ? updatedBy : null,
  };
}

function parseCatalog(value: unknown): ProfileSummary[] {
  if (!Array.isArray(value)) {
    throw new Error('server returned an invalid profile catalog response');
  }
  return value.map(parseProfileSummary).sort((a, b) => a.name.localeCompare(b.name));
}

function parseValidationIssues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ValidationIssue[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate['message'] !== 'string') continue;
    const rawPath = candidate['path'];
    const path = Array.isArray(rawPath)
      ? rawPath.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : [];
    issues.push({ path, message: candidate['message'] });
  }
  return issues;
}

class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: ValidationIssue[];
  readonly current?: ManifestData;

  constructor(status: number, payload: unknown) {
    const envelope = isRecord(payload) && isRecord(payload['error']) ? payload['error'] : undefined;
    const message = envelope?.['message'];
    super(typeof message === 'string' ? message : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    const code = envelope?.['code'];
    this.code = typeof code === 'string' ? code : undefined;
    this.details = parseValidationIssues(envelope?.['details']);
    const current = envelope?.['current'];
    if (current !== undefined) {
      try {
        this.current = parseManifestData(current);
      } catch {
        // The conflict remains actionable via the reload button if the optional
        // current snapshot is malformed.
      }
    }
  }
}

async function requestData(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  // window.fetch is wrapped by the shared admin layout to attach the CSRF
  // header to every mutating same-origin request.
  const response = await window.fetch(path, { ...init, headers });
  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }
  if (!response.ok) throw new ApiError(response.status, payload);
  if (response.status === 204) return null;
  if (!isRecord(payload) || !('data' in payload)) {
    throw new Error('server returned an invalid JSON response');
  }
  return payload['data'];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing profiles UI element #${id}`);
  return element as T;
}

function promptForName(action: string, suggestion = ''): string | null {
  const input = window.prompt(action, suggestion);
  if (input === null) return null;
  const name = input.trim();
  if (!PROFILE_NAME_PATTERN.test(name)) {
    window.alert('Profile names must be 1–64 letters, digits, underscores, or hyphens.');
    return null;
  }
  return name;
}

function newProfileManifest(name: string): string {
  // This placeholder deliberately matches no installed tool. It satisfies the
  // non-empty tools schema without granting access before the operator edits it.
  return `name: ${name}\nenable_code_mode: false\ntools:\n  # Replace this inert placeholder with the tool globs this profile may use.\n  - replace_with_tool_glob\ncredentials: {}\n`;
}

function manifestWithName(manifest: string, name: string): string {
  const topLevelName = /^name\s*:[^\r\n]*/m;
  if (topLevelName.test(manifest)) {
    return manifest.replace(topLevelName, `name: ${name}`);
  }
  return `name: ${name}\n${manifest}`;
}

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) return '(manifest)';
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`;
    return result ? `${result}.${part}` : part;
  }, '');
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

class ProfilesPage {
  private readonly filter = requiredElement<HTMLInputElement>('profile-filter');
  private readonly newButton = requiredElement<HTMLButtonElement>('profiles-new');
  private readonly exportButton = requiredElement<HTMLButtonElement>('profiles-export-all');
  private readonly count = requiredElement<HTMLElement>('profiles-count');
  private readonly catalogStatus = requiredElement<HTMLElement>('profiles-catalog-status');
  private readonly list = requiredElement<HTMLElement>('profiles-list');
  private readonly editorTitle = requiredElement<HTMLElement>('profile-editor-title');
  private readonly editorStateLabel = requiredElement<HTMLElement>('profile-editor-state');
  private readonly editorStatus = requiredElement<HTMLElement>('profile-editor-status');
  private readonly updated = requiredElement<HTMLTimeElement>('profile-updated');
  private readonly saveButton = requiredElement<HTMLButtonElement>('profile-save');
  private readonly validateButton = requiredElement<HTMLButtonElement>('profile-validate');
  private readonly reloadButton = requiredElement<HTMLButtonElement>('profile-reload');
  private readonly duplicateButton = requiredElement<HTMLButtonElement>('profile-duplicate');
  private readonly deleteButton = requiredElement<HTMLButtonElement>('profile-delete');
  private readonly message = requiredElement<HTMLElement>('profile-message');
  private readonly validationDetails = requiredElement<HTMLElement>('profile-validation-details');

  private readonly editorLock = new Compartment();
  private readonly view: EditorView;
  private profiles: ProfileSummary[] = [];
  private current: ManifestData | null = null;
  private draftName: string | null = null;
  private savedDocument = '';
  private busy = false;
  private catalogBusy = false;

  constructor() {
    this.view = new EditorView({
      state: this.createEditorState(''),
      parent: requiredElement<HTMLElement>('profile-editor'),
    });

    this.filter.addEventListener('input', () => this.renderCatalog());
    this.newButton.addEventListener('click', () => this.beginNew());
    this.exportButton.addEventListener('click', () => { void this.exportAll(); });
    this.saveButton.addEventListener('click', () => { void this.saveManifest(); });
    this.validateButton.addEventListener('click', () => { void this.validateManifest(); });
    this.reloadButton.addEventListener('click', () => { void this.reloadManifest(); });
    this.duplicateButton.addEventListener('click', () => { void this.duplicateManifest(); });
    this.deleteButton.addEventListener('click', () => { void this.deleteManifest(); });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.hasDocument()) {
        event.preventDefault();
        void this.saveManifest();
      }
    });
    window.addEventListener('beforeunload', (event) => {
      if (!this.isDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    });

    this.renderEditorChrome();
  }

  async start(): Promise<void> {
    await this.refreshCatalog();
    const deepLinkedName = new URL(window.location.href).searchParams.get('name');
    if (deepLinkedName) {
      await this.openProfile(deepLinkedName);
    } else {
      this.setMessage('Select a profile to edit, or create a new inert profile.', 'info');
    }
  }

  private hasDocument(): boolean {
    return this.current !== null || this.draftName !== null;
  }

  private isDirty(): boolean {
    if (this.draftName !== null) return true;
    return this.current !== null && this.view.state.doc.toString() !== this.savedDocument;
  }

  private canLeave(action: string): boolean {
    return !this.isDirty() || window.confirm(`${action} and discard the unsaved changes?`);
  }

  private lockExtensions(locked: boolean): Extension {
    return [EditorState.readOnly.of(locked), EditorView.editable.of(!locked)];
  }

  private createEditorState(documentText: string): EditorState {
    const locked = this.busy || !this.hasDocument();
    return EditorState.create({
      doc: documentText,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
        ]),
        StreamLanguage.define(yaml),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Profile YAML manifest' }),
        this.editorLock.of(this.lockExtensions(locked)),
        EDITOR_THEME,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.clearValidation();
          this.renderEditorChrome();
        }),
      ],
    });
  }

  private replaceEditor(documentText: string): void {
    this.view.setState(this.createEditorState(documentText));
    this.clearValidation();
    this.renderEditorChrome();
  }

  private updateEditorLock(): void {
    this.view.dispatch({
      effects: this.editorLock.reconfigure(this.lockExtensions(this.busy || !this.hasDocument())),
    });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.updateEditorLock();
    this.renderEditorChrome();
  }

  private setMessage(text: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    this.message.textContent = text;
    this.message.dataset['kind'] = kind;
    this.message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  private clearValidation(): void {
    this.validationDetails.replaceChildren();
  }

  private showError(error: unknown, prefix: string): void {
    this.setMessage(`${prefix}: ${errorMessage(error)}`, 'error');
    this.clearValidation();
    if (!(error instanceof ApiError)) return;
    const fragment = document.createDocumentFragment();
    for (const issue of error.details) {
      const item = document.createElement('li');
      item.textContent = `${formatIssuePath(issue.path)}: ${issue.message}`;
      fragment.appendChild(item);
    }
    this.validationDetails.appendChild(fragment);
  }

  private renderEditorChrome(): void {
    const dirty = this.isDirty();
    this.editorTitle.textContent = this.current?.name
      ?? (this.draftName !== null ? `new: ${this.draftName}` : 'no profile selected');
    this.editorStateLabel.hidden = !dirty;
    this.editorStateLabel.textContent = this.draftName !== null ? 'unsaved draft' : 'modified';

    if (this.current) {
      const source = this.profiles.find((profile) => profile.name === this.current?.name)?.source ?? 'unknown';
      this.editorStatus.textContent = `revision ${this.current.revision} · source ${source}`;
      const date = new Date(this.current.updated_at);
      if (Number.isFinite(date.getTime())) {
        const by = this.current.updated_by ? ` by ${this.current.updated_by}` : '';
        this.updated.dateTime = date.toISOString();
        this.updated.title = date.toISOString();
        this.updated.textContent = `last updated ${date.toLocaleString()}${by}`;
      } else {
        this.updated.textContent = '';
        this.updated.removeAttribute('datetime');
        this.updated.removeAttribute('title');
      }
    } else if (this.draftName !== null) {
      this.editorStatus.textContent = 'new profile · not created yet';
      this.updated.textContent = '';
      this.updated.removeAttribute('datetime');
      this.updated.removeAttribute('title');
    } else {
      this.editorStatus.textContent = 'Select a profile or create a new one.';
      this.updated.textContent = '';
      this.updated.removeAttribute('datetime');
      this.updated.removeAttribute('title');
    }

    const hasDocument = this.hasDocument();
    this.saveButton.disabled = this.busy || !hasDocument || !dirty;
    this.validateButton.disabled = this.busy || !hasDocument;
    this.reloadButton.disabled = this.busy || this.current === null;
    this.duplicateButton.disabled = this.busy || this.current === null;
    this.deleteButton.disabled = this.busy || this.current === null;
    this.newButton.disabled = this.busy;
    this.exportButton.disabled = this.busy || this.profiles.length === 0;
  }

  private renderCatalog(): void {
    const query = this.filter.value.trim().toLocaleLowerCase();
    const visible = this.profiles.filter((profile) => {
      if (!query) return true;
      return profile.name.toLocaleLowerCase().includes(query)
        || profile.source.toLocaleLowerCase().includes(query)
        || profile.tools.some((tool) => tool.toLocaleLowerCase().includes(query));
    });

    this.count.textContent = query ? `${visible.length}/${this.profiles.length}` : String(this.profiles.length);
    this.catalogStatus.textContent = this.profiles.length === 0
      ? 'no profiles defined'
      : visible.length === 0 ? 'no profiles match the filter' : `${visible.length} shown`;
    this.list.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (const profile of visible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-list-item';
      button.dataset['name'] = profile.name;
      button.setAttribute('role', 'option');
      const selected = this.current?.name === profile.name;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
      button.addEventListener('click', () => { void this.openProfile(profile.name); });

      const name = document.createElement('span');
      name.className = 'profile-list-name';
      name.textContent = profile.name;
      button.appendChild(name);

      const details = [`${profile.tools.length} tool pattern${profile.tools.length === 1 ? '' : 's'}`, profile.source];
      if (profile.enable_code_mode) details.push('code mode');
      const meta = document.createElement('span');
      meta.className = 'profile-list-meta';
      meta.textContent = details.join(' · ');
      button.appendChild(meta);

      if (profile.updated_at !== undefined) {
        const date = new Date(profile.updated_at);
        if (Number.isFinite(date.getTime())) {
          const updated = document.createElement('span');
          updated.className = 'profile-list-updated';
          updated.textContent = `updated ${date.toLocaleString()}`;
          updated.title = date.toISOString();
          button.appendChild(updated);
        }
      }
      fragment.appendChild(button);
    }
    this.list.appendChild(fragment);
  }

  private async refreshCatalog(): Promise<void> {
    if (this.catalogBusy) return;
    this.catalogBusy = true;
    this.catalogStatus.textContent = 'loading profiles…';
    try {
      const data = await requestData('/api/v1/profiles');
      this.profiles = parseCatalog(data);
      this.renderCatalog();
      this.renderEditorChrome();
    } catch (error) {
      this.catalogStatus.textContent = `catalog error: ${errorMessage(error)}`;
    } finally {
      this.catalogBusy = false;
    }
  }

  private updateDeepLink(name: string | null): void {
    const url = new URL(window.location.href);
    if (name === null) url.searchParams.delete('name');
    else url.searchParams.set('name', name);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  private acceptManifest(data: ManifestData): void {
    this.current = data;
    this.draftName = null;
    this.savedDocument = data.manifest;
    this.replaceEditor(data.manifest);
    this.updateDeepLink(data.name);
    this.renderCatalog();
  }

  private async openProfile(name: string, force = false): Promise<void> {
    if (this.busy) return;
    if (!force && this.current?.name === name && this.draftName === null) return;
    if (!this.canLeave('Switch profiles')) return;

    this.setBusy(true);
    this.clearValidation();
    this.setMessage(`loading ${name}…`);
    try {
      const data = parseManifestData(await requestData(`/api/v1/profiles/${encodeURIComponent(name)}/manifest`));
      this.acceptManifest(data);
      await this.refreshCatalog();
      this.setMessage(`loaded ${data.name} at revision ${data.revision}.`, 'success');
    } catch (error) {
      this.showError(error, 'Load failed');
    } finally {
      this.setBusy(false);
    }
  }

  private beginNew(): void {
    if (this.busy) return;
    const name = promptForName('Name for the new profile:');
    if (name === null) return;
    if (this.profiles.some((profile) => profile.name === name)) {
      window.alert(`Profile '${name}' already exists.`);
      return;
    }
    if (!this.canLeave('Start a new profile')) return;

    this.current = null;
    this.draftName = name;
    this.savedDocument = '';
    this.replaceEditor(newProfileManifest(name));
    this.updateDeepLink(null);
    this.renderCatalog();
    this.setMessage('New inert draft. Replace the placeholder tool pattern, validate, then save to create it.', 'info');
    this.view.focus();
  }

  private async reloadManifest(): Promise<void> {
    if (!this.current) return;
    await this.openProfile(this.current.name, true);
  }

  private async validateManifest(): Promise<boolean> {
    if (this.busy || !this.hasDocument()) return false;
    const manifest = this.view.state.doc.toString();
    const body: { manifest: string; name?: string } = { manifest };
    if (this.current) body.name = this.current.name;

    this.setBusy(true);
    this.clearValidation();
    this.setMessage('validating manifest…');
    try {
      await requestData('/api/v1/profiles/validate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      this.setMessage('Manifest is valid.', 'success');
      return true;
    } catch (error) {
      this.showError(error, 'Validation failed');
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  private async saveManifest(): Promise<void> {
    if (this.busy || !this.hasDocument() || !this.isDirty()) return;
    const creating = this.draftName !== null;
    const baseRevision = this.current?.revision;
    const manifest = this.view.state.doc.toString();

    this.setBusy(true);
    this.clearValidation();
    this.setMessage(creating ? 'creating profile…' : 'saving manifest…');
    try {
      const path = creating
        ? '/api/v1/profiles/manifest'
        : `/api/v1/profiles/${encodeURIComponent(this.current?.name ?? '')}/manifest`;
      const body = creating ? { manifest } : { manifest, base_revision: baseRevision };
      const data = parseManifestData(await requestData(path, {
        method: creating ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      }));
      this.acceptManifest(data);
      await this.refreshCatalog();
      this.setMessage(`${creating ? 'Created' : 'Saved'} ${data.name} at revision ${data.revision}.`, 'success');
    } catch (error) {
      if (!creating && error instanceof ApiError && error.status === 409
        && error.code === 'revision_conflict' && error.current) {
        const latest = error.current;
        if (window.confirm(`${error.message}\n\nReload revision ${latest.revision}? Your unsaved changes will be replaced.`)) {
          this.acceptManifest(latest);
          await this.refreshCatalog();
          this.setMessage(`Loaded latest revision ${latest.revision}; the conflicting edits were discarded.`, 'warning');
        } else {
          this.setMessage('Revision conflict. Your edits remain in the editor; reload or resolve against the latest revision before saving again.', 'warning');
        }
      } else {
        this.showError(error, creating ? 'Create failed' : 'Save failed');
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async duplicateManifest(): Promise<void> {
    if (this.busy || !this.current) return;
    const suggestion = `${this.current.name.slice(0, 59)}_copy`;
    const name = promptForName('Name for the duplicate profile:', suggestion);
    if (name === null) return;
    if (this.profiles.some((profile) => profile.name === name)) {
      window.alert(`Profile '${name}' already exists.`);
      return;
    }
    if (!this.canLeave('Create the duplicate and switch to it')) return;

    const manifest = manifestWithName(this.view.state.doc.toString(), name);
    this.setBusy(true);
    this.clearValidation();
    this.setMessage(`duplicating ${this.current.name} to ${name}…`);
    try {
      const data = parseManifestData(await requestData('/api/v1/profiles/manifest', {
        method: 'POST',
        body: JSON.stringify({ manifest }),
      }));
      this.acceptManifest(data);
      await this.refreshCatalog();
      this.setMessage(`Created duplicate ${data.name}.`, 'success');
    } catch (error) {
      this.showError(error, 'Duplicate failed');
    } finally {
      this.setBusy(false);
    }
  }

  private async deleteManifest(): Promise<void> {
    if (this.busy || !this.current) return;
    const name = this.current.name;
    const dirtyWarning = this.isDirty() ? '\n\nUnsaved editor changes will also be discarded.' : '';
    if (!window.confirm(`Delete profile '${name}'? This cannot be undone.${dirtyWarning}`)) return;

    this.setBusy(true);
    this.clearValidation();
    this.setMessage(`deleting ${name}…`);
    try {
      await requestData(`/api/v1/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
      this.current = null;
      this.draftName = null;
      this.savedDocument = '';
      this.replaceEditor('');
      this.updateDeepLink(null);
      await this.refreshCatalog();
      this.setMessage(`Deleted ${name}.`, 'success');
    } catch (error) {
      this.showError(error, 'Delete failed');
    } finally {
      this.setBusy(false);
    }
  }

  private async exportAll(): Promise<void> {
    if (this.busy || this.profiles.length === 0) return;
    this.setBusy(true);
    this.setMessage(`exporting ${this.profiles.length} profiles…`);
    try {
      const manifests: ManifestData[] = [];
      for (const profile of this.profiles) {
        const data = parseManifestData(await requestData(`/api/v1/profiles/${encodeURIComponent(profile.name)}/manifest`));
        manifests.push(data);
        this.setMessage(`exported ${manifests.length}/${this.profiles.length} profiles…`);
      }
      downloadJson(`splicedock-profiles-${new Date().toISOString().slice(0, 10)}.json`, {
        exported_at: new Date().toISOString(),
        profiles: manifests,
      });
      this.setMessage(`Exported ${manifests.length} profiles as JSON.`, 'success');
    } catch (error) {
      this.showError(error, 'Export failed (no partial file was downloaded)');
    } finally {
      this.setBusy(false);
    }
  }
}

function boot(): void {
  if (!document.getElementById('profiles-page')) return;
  const page = new ProfilesPage();
  void page.start().catch((error: unknown) => {
    // Initialization errors still need to be visible if catalog loading itself
    // fails in an unexpected way; all API responses remain text-only.
    const message = document.getElementById('profile-message');
    if (message) {
      message.textContent = `Initialization failed: ${errorMessage(error)}`;
      message.dataset['kind'] = 'error';
      message.setAttribute('role', 'alert');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
