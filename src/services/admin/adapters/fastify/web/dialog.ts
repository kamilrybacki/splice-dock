// Shared read-only detail dialog built on the native <dialog> element.
//
// Pure HTML-string rendering. Behaviour (showModal, focus, scroll lock) lives
// in dialog-assets.ts. Callers pass already-escaped HTML for `hero`, `content`
// and `measured`; plain strings (`title`, `scope`, `definition`, cta) are
// escaped here. Data comes from the page snapshot: nothing is fetched on open.

import { escapeHtml } from './components.js';

export interface MetricDialogOptions {
  /** Unique element id; also the value of the opener's data-md-open. */
  id: string;
  title: string;
  /** Short scope line under the title. */
  scope: string;
  /** Trusted HTML: the main number and its basis. */
  hero: string;
  /** One-sentence definition; also the aria-describedby target. */
  definition: string;
  /** Trusted HTML: the single chart / ranking and its states. */
  content: string;
  /** Trusted HTML for the collapsed "How this is measured" body. */
  measured: string;
  /** Trusted HTML for the snapshot stamp. */
  snapshot: string;
  cta: { href: string; label: string };
}

export function renderDetailsButton(dialogId: string, ariaLabel: string): string {
  return `<button type="button" class="md-open ghost" data-md-open="${escapeHtml(dialogId)}" aria-haspopup="dialog" aria-label="${escapeHtml(ariaLabel)}">Details</button>`;
}

export function renderMetricDialog(o: MetricDialogOptions): string {
  const id = escapeHtml(o.id);
  return `<dialog id="${id}" class="md-dialog" aria-labelledby="${id}-title" aria-describedby="${id}-desc">
<div class="md-shell">
<header class="md-header">
<div class="md-heading"><h2 id="${id}-title" tabindex="-1">${escapeHtml(o.title)}</h2><p class="md-scope">${escapeHtml(o.scope)}</p></div>
<button type="button" class="md-close" data-md-close aria-label="Close ${escapeHtml(o.title)} details">Close</button>
</header>
<div class="md-body">
<div class="md-hero">${o.hero}</div>
<p class="md-definition" id="${id}-desc">${escapeHtml(o.definition)}</p>
<div class="md-content">${o.content}</div>
<details class="md-measured"><summary>How this is measured</summary>${o.measured}</details>
</div>
<footer class="md-footer">
<p class="md-snapshot">${o.snapshot}</p>
<a class="md-cta" href="${escapeHtml(o.cta.href)}">${escapeHtml(o.cta.label)}</a>
</footer>
</div>
</dialog>`;
}
