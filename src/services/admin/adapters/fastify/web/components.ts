// HTML-string component helpers for the admin UI.
//
// Pure functions, no I/O, no state, no DOM. Every user-controlled value is
// HTML-escaped before being interpolated. Variants map to CSS classes defined
// in layout.ts (e.g. `pill pill-allow`, `card`, `kpi`, `spark`, `kbd`).

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PILL_VARIANTS = new Set([
  'allow',
  'deny',
  'warn',
  'info',
  'accent',
  'muted',
  'override',
  'file',
  'approval',
]);

// Variants that have no dedicated CSS class are remapped to an existing one.
const PILL_VARIANT_REMAP: Record<string, string> = {
  approval: 'info',
};

export function pill(label: string, variant?: string): string {
  const resolved = (variant && PILL_VARIANT_REMAP[variant]) ?? variant;
  const cls = resolved && PILL_VARIANTS.has(resolved) ? `pill pill-${resolved}` : 'pill';
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

interface CardOpts {
  title?: string;
  actions?: string; // trusted HTML — caller is responsible for escaping
  body: string;    // trusted HTML — caller is responsible for escaping
  muted?: boolean;
}

export function card(opts: CardOpts): string {
  const cls = opts.muted ? 'card muted' : 'card';
  // Treat empty strings as absent — an empty title would otherwise render a
  // bordered header strip with no content.
  const hasTitle = typeof opts.title === 'string' && opts.title.length > 0;
  const hasActions = typeof opts.actions === 'string' && opts.actions.length > 0;
  let header = '';
  if (hasTitle || hasActions) {
    const titleHtml = hasTitle
      ? `<span class="title">${escapeHtml(opts.title)}</span>`
      : '';
    const actionsHtml = hasActions
      ? `<span class="actions">${opts.actions}</span>`
      : '';
    header = `<div class="card-header">${titleHtml}${actionsHtml}</div>`;
  }
  return `<div class="${cls}">${header}<div class="card-body">${opts.body}</div></div>`;
}

export function kpi(
  label: string,
  value: string | number,
  hint?: string,
  extraClass?: string,
): string {
  const hintHtml = hint
    ? `<span class="kpi-hint">${escapeHtml(hint)}</span>`
    : '';
  const cls = extraClass ? `kpi ${escapeHtml(extraClass)}` : 'kpi';
  return `<div class="${cls}">
<span class="kpi-label">${escapeHtml(label)}</span>
<span class="kpi-value">${escapeHtml(value)}</span>
${hintHtml}
</div>`;
}

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Missing data (null / undefined / empty series) draws no sparkline at all: a
 * muted dash, never a flat line of zeros that reads as "zero traffic". A real
 * series that happens to be all zeros still draws its flat baseline.
 */
export function spark(buckets: number[] | null | undefined, opts?: { width?: number }): string {
  if (!buckets || buckets.length === 0) {
    return '<span class="spark spark-empty" title="no data">—</span>';
  }
  // Width precedence:
  //   1. opts.width if explicitly provided
  //   2. buckets.length if > 0
  //   3. fall back to 8 (empty-state default)
  let width: number;
  if (opts?.width !== undefined) {
    width = Math.max(1, opts.width);
  } else if (buckets.length > 0) {
    width = buckets.length;
  } else {
    width = 8;
  }
  // Pad or truncate to width
  const arr: number[] = buckets.slice(-width);
  while (arr.length < width) arr.unshift(0);

  const max = arr.reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0) {
    return `<span class="spark spark-empty">${'▁'.repeat(width)}</span>`;
  }
  const chars = arr.map((v) => {
    if (v <= 0) return '▁';
    const idx = Math.min(
      SPARK_CHARS.length - 1,
      Math.max(0, Math.floor((v / max) * (SPARK_CHARS.length - 1))),
    );
    return SPARK_CHARS[idx];
  }).join('');
  return `<span class="spark">${escapeHtml(chars)}</span>`;
}

export function tagList(items: string[], variant?: string): string {
  if (!items || items.length === 0) return '<span class="tag-list"></span>';
  const inner = items.map((t) => pill(t, variant)).join(' ');
  return `<span class="tag-list">${inner}</span>`;
}

export function kbd(key: string): string {
  return `<kbd>${escapeHtml(key)}</kbd>`;
}
