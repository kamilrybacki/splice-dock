// Profiles catalog and YAML editor mount.
//
// This module returns static markup only. Profile names, manifests, validation
// errors, and timestamps are rendered by profile-editor/main.ts using DOM APIs
// (textContent in particular), never interpolated into this HTML.

const STYLES = `
.profiles-heading { margin-top: 0; }
.profiles-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); align-items: start; }
.profiles-catalog, .profiles-editor-card { min-width: 0; }
.profiles-catalog-count { margin-left: auto; }
.profiles-filter { width: 100%; min-width: 0; }
.profiles-catalog-actions { margin-top: var(--gap-sm); }
.profiles-list { display: flex; flex-direction: column; gap: 0.4rem; max-height: 65vh; overflow-y: auto; margin-top: var(--gap-sm); }
.profile-list-item { display: block; width: 100%; padding: 0.5rem 0.6rem; text-align: left; white-space: normal; background: var(--surface-2); }
.profile-list-item:hover { background: var(--accent-soft); }
.profile-list-item.selected { border-color: var(--accent); background: var(--accent-soft); }
.profile-list-name { display: block; color: var(--fg); font-weight: 700; overflow-wrap: anywhere; }
.profile-list-meta, .profile-list-updated { display: block; margin-top: 0.2rem; color: var(--fg-muted); font-size: var(--fz-sm); overflow-wrap: anywhere; }
.profiles-editor-title { margin: 0; overflow-wrap: anywhere; }
.profiles-editor-state { margin-left: auto; color: var(--warn); font-size: var(--fz-sm); font-weight: 400; }
.profiles-editor-status { min-height: 1.5em; }
.profiles-editor-host { min-width: 0; margin: var(--gap-sm) 0; }
.profiles-editor-host .cm-editor { border: 1px solid var(--border); border-radius: var(--radius); height: clamp(24rem, 65vh, 52rem); }
.profiles-editor-host .cm-editor.cm-focused { outline: 1px solid var(--accent); outline-offset: -1px; }
.profiles-editor-host .cm-scroller { font-family: var(--font); line-height: 1.55; }
.profiles-editor-host .cm-panels { background: var(--surface-2); color: var(--fg); border-color: var(--border); }
.profiles-editor-host .cm-panels.cm-panels-top { border-bottom-color: var(--border); }
.profiles-editor-host .cm-panels.cm-panels-bottom { border-top-color: var(--border); }
.profiles-editor-host .cm-search { font-size: var(--fz-sm); }
.profiles-editor-host .cm-search input, .profiles-editor-host .cm-search button { font-size: var(--fz-sm); }
.profiles-editor-host .cm-tooltip { background: var(--surface-2); border-color: var(--border); color: var(--fg); }
.profiles-editor-actions { display: flex; gap: var(--gap-sm); flex-wrap: wrap; padding-top: var(--gap-sm); border-top: 1px solid var(--border); }
.profiles-editor-hint { margin-bottom: 0; }
.profiles-message { margin: var(--gap-sm) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.profiles-message:empty { display: none; }
.profiles-message[data-kind="error"] { color: var(--danger); }
.profiles-message[data-kind="success"] { color: var(--success); }
.profiles-message[data-kind="warning"] { color: var(--warn); }
.profiles-validation-details { margin: var(--gap-sm) 0 0; padding-left: 1.5rem; color: var(--danger); font-size: var(--fz-sm); overflow-wrap: anywhere; }
.profiles-validation-details:empty { display: none; }
@media (min-width: 900px) {
  .profiles-layout { grid-template-columns: 17rem minmax(0, 1fr); }
  .profiles-catalog { position: sticky; top: 4.5rem; }
}
`;

export function renderProfilesPage(): string {
  return `<style>${STYLES}</style>
<section id="profiles-page" aria-labelledby="profiles-heading">
  <h2 id="profiles-heading" class="profiles-heading">profiles</h2>
  <p class="muted">Edit profile manifests with optimistic revision checks. YAML is validated by the server before it is saved.</p>

  <div class="profiles-layout">
    <aside class="card profiles-catalog" aria-label="profile catalog">
      <div class="card-header">
        catalog <span id="profiles-count" class="pill pill-muted profiles-catalog-count">0</span>
      </div>
      <div class="card-body">
        <label for="profile-filter">filter profiles</label>
        <input id="profile-filter" class="profiles-filter" type="search" placeholder="name, tool, or source" autocomplete="off" spellcheck="false" />
        <div class="row profiles-catalog-actions">
          <button id="profiles-new" type="button" class="primary">new</button>
          <button id="profiles-export-all" type="button" disabled>export all</button>
        </div>
        <p id="profiles-catalog-status" class="muted" role="status">loading profiles…</p>
        <div id="profiles-list" class="profiles-list" role="listbox" aria-label="available profiles"></div>
      </div>
    </aside>

    <section class="card profiles-editor-card" aria-labelledby="profile-editor-title">
      <div class="card-header">
        <h3 id="profile-editor-title" class="profiles-editor-title">no profile selected</h3>
        <span id="profile-editor-state" class="profiles-editor-state" hidden></span>
      </div>
      <div class="card-body">
        <p id="profile-editor-status" class="muted profiles-editor-status">Select a profile or create a new one.</p>
        <p class="muted"><time id="profile-updated"></time></p>
        <div id="profile-editor" class="profiles-editor-host"></div>
        <div class="profiles-editor-actions">
          <button id="profile-save" type="button" class="primary" disabled>save</button>
          <button id="profile-validate" type="button" disabled>validate</button>
          <button id="profile-reload" type="button" disabled>reload</button>
          <button id="profile-duplicate" type="button" disabled>duplicate</button>
          <button id="profile-delete" type="button" class="danger" disabled>delete</button>
        </div>
        <p class="muted profiles-editor-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> saves. Unsaved changes are confirmed before leaving the editor.</p>
        <p id="profile-message" class="profiles-message" role="status" aria-live="polite"></p>
        <ol id="profile-validation-details" class="profiles-validation-details"></ol>
      </div>
    </section>
  </div>
  <noscript><p class="profiles-message" data-kind="error">JavaScript is required to edit profiles.</p></noscript>
</section>
<script src="/admin/profiles-editor.js" defer></script>`;
}
