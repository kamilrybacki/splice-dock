// CSS and client script for the shared metric dialog (see dialog.ts).
// Uses the existing Splicedock tokens only; one muted accent for all bars.

export const DIALOG_STYLES = `
/* Metric cards + detail dialog */
.metric-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--gap); margin-bottom: 1.25rem; }
.metric-card { min-width: 0; padding: .6rem .85rem; background: var(--surface); border: 1px solid var(--border); border-top: 2px solid var(--accent); display: flex; flex-direction: column; gap: .15rem; }
.metric-card .kpi-label { display: block; }
.metric-card .metric-value { font-size: 2rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.metric-card .metric-rate { font-size: 1.1rem; font-weight: 500; color: var(--fg-muted); margin-left: .4rem; }
.metric-card .metric-sub { color: var(--fg-muted); font-size: var(--fz-sm); overflow-wrap: anywhere; }
.metric-card .md-open { align-self: flex-start; min-height: 44px; min-width: 44px; margin-top: .15rem; padding: .5rem .25rem; color: var(--accent); text-decoration: underline; }

.md-dialog { padding: 0; border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg); width: min(720px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); max-height: calc(100dvh - 2rem); overscroll-behavior: contain; }
.md-dialog[open] { display: flex; }
.md-dialog::backdrop { background: rgba(0, 0, 0, .7); }
.md-shell { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%; }
.md-header { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); }
.md-heading { min-width: 0; }
.md-header h2 { margin: 0; font-size: 1.3rem; }
.md-header h2:focus { outline: none; }
.md-header h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.md-scope { margin: .15rem 0 0; color: var(--fg-muted); font-size: 13px; overflow-wrap: anywhere; }
.md-close { flex: none; min-width: 44px; min-height: 44px; padding: .5rem 1rem; }
.md-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; font-size: 16px; }
.md-body > * { margin: 0; }
.md-hero .md-number { display: block; font-size: 2rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.md-hero .md-basis { display: block; color: var(--fg-muted); font-size: 13px; overflow-wrap: anywhere; }
.md-definition { color: var(--fg-muted); }
.md-note { color: var(--fg-muted); font-size: 13px; margin: .5rem 0 0; }
.md-measured > summary { cursor: pointer; color: var(--fg-muted); min-height: 44px; display: flex; align-items: center; }
.md-measured p { font-size: 13px; color: var(--fg-muted); }
.md-footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.5rem; border-top: 1px solid var(--border); }
.md-snapshot { margin: 0; color: var(--fg-muted); font-size: 13px; }
.md-cta { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 1rem; background: var(--accent); color: var(--bg); font-weight: 700; }
.md-cta:hover { text-decoration: none; filter: brightness(1.1); }
.md-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .9rem; }
.md-rules li { min-width: 0; }
.md-rules .rule-head { display: flex; gap: .75rem; align-items: baseline; justify-content: space-between; }
.md-rules .rule-name { min-width: 0; overflow-wrap: anywhere; font-family: var(--font); font-size: 14px; }
.md-rules .rule-count { flex: none; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.md-rules .rule-bar { display: block; height: 4px; margin-top: .3rem; background: var(--surface-2); }
.md-rules .rule-bar > span { display: block; height: 100%; min-width: 2px; background: var(--accent); }
.md-rules .rule-unattributed .rule-name { font-family: var(--sans); color: var(--fg-muted); font-style: italic; }
.md-rest { margin-top: 1rem; }
.md-rest > summary { cursor: pointer; color: var(--fg-muted); min-height: 44px; display: flex; align-items: center; }
.hist { list-style: none; margin: 0; padding: 0; height: 180px; display: flex; align-items: flex-end; gap: 2px; border-bottom: 1px solid var(--border-strong); }
.hist li { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
.hist li > span { display: block; width: 100%; min-height: 1px; background: var(--accent); }
.hist li.hist-live > span { background: repeating-linear-gradient(45deg, var(--accent) 0 3px, var(--accent-soft) 3px 6px); }
.hist li:focus-visible { outline: 2px solid var(--accent); }
.hist-axis { display: flex; justify-content: space-between; margin-top: .25rem; color: var(--fg-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.hist-readout { min-height: 1.5em; margin-top: .5rem; color: var(--fg); font-size: 14px; }
.md-table { width: 100%; font-size: 13px; }
.md-table td, .md-table th { padding: .35rem .5rem; }
.md-table td:last-child, .md-table th:last-child { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
body.md-locked { position: fixed; left: 0; right: 0; width: 100%; overflow: hidden; }

@media (max-width: 599px) {
  .md-dialog { width: 100vw; max-width: none; height: 100vh; height: 100dvh; max-height: none; margin: 0; border: 0; }
  .md-header { padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) .75rem max(1rem, env(safe-area-inset-left)); }
  .md-body { padding: 1rem max(1rem, env(safe-area-inset-right)) 1rem max(1rem, env(safe-area-inset-left)); gap: 1.25rem; }
  .md-footer { flex-direction: column-reverse; align-items: stretch; gap: .5rem; padding: .75rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
  .md-cta { width: 100%; }
  .hist { height: 140px; }
}
`;

export const DIALOG_SCRIPT = `
(function () {
  var opener = null;
  var savedY = 0;
  function lock() {
    savedY = window.scrollY || 0;
    document.body.style.top = '-' + savedY + 'px';
    document.body.classList.add('md-locked');
  }
  function unlock() {
    document.body.classList.remove('md-locked');
    document.body.style.top = '';
    window.scrollTo(0, savedY);
  }
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var open = t.closest('[data-md-open]');
    if (open) {
      var dlg = document.getElementById(open.getAttribute('data-md-open'));
      if (!dlg || typeof dlg.showModal !== 'function' || dlg.open) return;
      opener = open;
      lock();
      dlg.showModal();
      var h = dlg.querySelector('h2[tabindex]');
      if (h) h.focus();
      return;
    }
    var close = t.closest('[data-md-close]');
    if (close) {
      var d = close.closest('dialog');
      if (d) d.close();
      return;
    }
    var bar = t.closest('[data-hist-label]');
    if (bar) showReadout(bar);
  });
  function showReadout(el) {
    var box = el.closest('.md-content');
    var out = box && box.querySelector('.hist-readout');
    if (out) out.textContent = el.getAttribute('data-hist-label');
  }
  document.addEventListener('focusin', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (t && t.hasAttribute('data-hist-label')) showReadout(t);
  });
  document.addEventListener('close', function (e) {
    if (!(e.target instanceof HTMLDialogElement) || !e.target.classList.contains('md-dialog')) return;
    unlock();
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }, true);
})();
`;
