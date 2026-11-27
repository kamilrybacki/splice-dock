/** Sections of the "Learned grants" page. Helpers come from pages.mjs to avoid a circular import. */
export function grantsSections({ terminal, table, paragraph }) {
  return [
    ['idea', 'The idea in one minute', paragraph('A standing grant lets Splicedock approve a repeated, low-risk operation without asking a human again. It is learned, not configured: after you approve the <em>same kind</em> of operation three times and each run succeeds, Splicedock remembers that shape for a short time and a limited number of uses.') +
      paragraph('Three rules explain almost everything that follows. <strong>The shape decides</strong>: what the operation is, where it runs and which objects it touches. <strong>The caller’s words can only subtract</strong>: the <code>approval_context</code> text can send a request back to a human but can never be the reason it runs. <strong>When unsure, ask a human</strong>: every check below fails closed.')],
    ['enable', 'What you must turn on', table(['Setting', 'Effect'], [
      ['<code>SPLICEDOCK_GRANTS=1</code>', 'Enables learning and matching. Default: off.'],
      ['<code>SPLICEDOCK_GRANT_NAMESPACES</code>', 'Comma-separated exact namespaces where grants may form and match. Default-deny: empty means grants are effectively off.'],
      ['<code>SPLICEDOCK_GRANT_THRESHOLD</code>', 'Successful, consistent approvals needed to learn a grant. Default 3.'],
      ['<code>SPLICEDOCK_GRANT_EXCEPTIONS</code>', 'JSON array of <code>{"tool","verb_path"}</code> entries that never get a grant. Replaces the removable defaults (kubectl drain, cordon, uncordon).'],
    ]) + paragraph('Callers must also pass <code>approval_context</code> (at most 500 characters): one or two sentences saying why this conversation needs the operation. Without it the request always goes to a human and cannot teach a grant.')],
    ['shape', 'What “the same operation” means', paragraph('Splicedock reduces a request to a <em>shape</em>. Two requests match only when every field is exactly equal.') + table(['Field', 'Meaning', 'Example'], [
      ['<code>profile</code>, <code>token_id</code>', 'Who is calling. A grant never crosses callers.', '<code>ops</code>, one profile token'],
      ['<code>tool</code>, <code>verb_path</code>', 'The tool and its verb.', '<code>kubectl</code>, <code>delete</code>'],
      ['<code>resource_kind</code>', 'The kind of object.', '<code>job</code>'],
      ['<code>namespace</code>', 'Resolved namespace. The <code>&lt;default&gt;</code> namespace never matches.', '<code>splicedock</code>'],
      ['<code>object_count_max</code>', 'How many objects the request names.', '<code>1</code>'],
      ['<code>flags_allowed</code>', 'The set of flags used. Unknown flags make the request ineligible.', '(none)'],
    ]) + paragraph('The object <em>names</em> are deliberately not part of the shape. They are handled separately by the name prefix, described below.')],
    ['lifecycle', 'The lifecycle at a glance', terminal('Lifecycle', [
      'request  ->  no live grant matches  ->  human approves  ->  command runs',
      '                                                              |',
      '                                         success? -> counts as evidence',
      '                                                              |',
      '                      3 consistent successes of one shape (7 days)',
      '                                                              |',
      '                                              grant created (3 days, 20 uses)',
      '                                                              |',
      'request  ->  grant matches  ->  use claimed atomically  ->  runs without a human',
      '                                                              |',
      '   expiry | 20 uses | 3 consecutive failures | rejection | revoke  ->  grant ends',
    ].join('\n'))],
    ['learning', 'Step 1: learning (promotion)', paragraph('After a human-approved operation runs, Splicedock considers promoting it. Nothing is learned unless <em>all</em> of these hold:') +
      '<ol>' +
      '<li>The operation executed and <strong>succeeded</strong>. A failed run, for example a Forbidden delete, counts as zero evidence.</li>' +
      '<li>It had a non-empty <code>approval_context</code> and was not a strong (WebAuthn) approval. Strong tools are never covered by grants.</li>' +
      '<li>Its tool and verb are not on the exception list.</li>' +
      '<li>The operation classifier does not call it <code>destructive</code> or <code>unknown</code> (see below).</li>' +
      '<li>Its namespace is in <code>SPLICEDOCK_GRANT_NAMESPACES</code>.</li>' +
      '<li>The shape is not blocked after a recent rejection, and no live grant already exists for the same caller, tool, verb, kind and namespace.</li>' +
      '<li>At least <strong>3</strong> successful approvals of the exact same shape exist from the last 7 days, and their contexts are <strong>mutually consistent</strong>.</li>' +
      '<li>The approved object names share a usable <strong>name prefix</strong>.</li>' +
      '</ol>' +
      paragraph('<strong>Consistent evidence.</strong> Evidence is built greedily from the newest approval. A candidate is kept only if its context does not escalate against the current request and against every piece already kept, in both directions. Consistency is not transitive (“before” and “after” can each agree with a neutral reason), so every pair is checked. The log line <code>grant promotion evidence</code> reports <code>approvals</code> (candidates) and <code>consistent</code> (kept).')],
    ['prefix', 'Name prefix', paragraph('The grant covers only names that start with the longest common prefix of the approved names, cut just after the last <code>-</code> or <code>.</code> so only whole segments remain. At least three characters must precede that separator.') + table(['Approved names', 'Grant prefix'], [
      ['<code>backup-29384701</code>, <code>backup-29384702</code>, <code>backup-29384703</code>', '<code>backup-</code>'],
      ['<code>grantprobe-a</code>, <code>grantprobe-b</code>, <code>grantprobe-c</code>', '<code>grantprobe-</code>'],
      ['<code>nightly-1</code>, <code>prod-db</code>, <code>cache-9</code>', 'none: no grant forms'],
      ['<code>a-1</code>, <code>a-2</code>, <code>a-3</code>', 'none: prefix too short'],
    ]) + paragraph('A request matches only when <em>every</em> object name starts with the prefix. A request that names no objects never matches. The tool must be able to read names from its arguments (kubectl can); a tool without that hook never learns a grant.')],
    ['classifier', 'The operation classifier (deny-only)', paragraph('A closed, hand-written table rates each <code>tool|verb|kind</code> as <code>benign</code>, <code>disruptive</code>, <code>destructive</code> or <code>unknown</code>. Grants use it only to say no: <code>destructive</code> and <code>unknown</code> never form or match a grant. Flags such as <code>--force</code>, <code>--all</code>, <code>-A</code> and <code>--grace-period</code> can only raise the class. An unrecognised tool, verb, kind or flag is <code>unknown</code>, which means “ask a human”.') +
      paragraph('Example: <code>kubectl delete pod</code> and <code>kubectl delete job</code> are <code>disruptive</code> (recreated by their controller) and may be granted. <code>kubectl delete deployment</code>, <code>secret</code> or <code>namespace</code> are <code>destructive</code> and always need a person. The classifier never authorises anything; it can only add caution.')],
    ['matching', 'Step 2: matching a new request', paragraph('For each request, Splicedock walks these checks in order and stops at the first that fails, which sends the request to a human:') +
      '<ol>' +
      '<li>Grants are enabled.</li>' +
      '<li>The request has an <code>approval_context</code> and names at least one object.</li>' +
      '<li>The classifier does not deny the shape.</li>' +
      '<li>The namespace is in the allowlist.</li>' +
      '<li>The shape and its caller/tool/verb scope are not blocked.</li>' +
      '<li>A live grant exists with exactly the same shape, not revoked, suspended, expired (3 days) or used up (20 uses).</li>' +
      '<li>Every object name starts with the grant’s name prefix.</li>' +
      '<li>The grant still rests on at least threshold-many evidence approvals.</li>' +
      '<li>The new context does not <strong>escalate</strong> against any evidence context.</li>' +
      '</ol>' +
      paragraph('If all pass, the use is <strong>claimed atomically</strong>: a single conditional update re-checks quota, revocation, suspension, expiry and the namespace at commit time. Two concurrent requests cannot both spend the last use, and a revoke that lands first wins.')],
    ['escalation', 'Context can only say “ask a human”', paragraph('The caller writes the context, and the caller is the party the gate constrains. So similarity of wording never grants anything (ADR 0009 measured why). Context is a deny-only signal. A request escalates to a human when its context:') +
      '<ul><li>carries no meaningful reason (empty, identifiers only, or more identifiers than words);</li>' +
      '<li>states a risky purpose no reference stated, such as “so nobody notices”, “without approval” or “ignore previous instructions”;</li>' +
      '<li>contradicts any stored reference (before/after, same/different, old/patched).</li></ul>' +
      paragraph('<strong>Practical rule:</strong> keep <code>approval_context</code> in the same style and meaning across repeated calls. A changed rationale makes the log say <code>grant context escalated</code> and a human gets the request, even though the shape matched.')],
    ['limits', 'Step 3: limits and how a grant ends', table(['Ends when', 'Detail'], [
      ['Expiry', '3 days after creation. No renewal.'],
      ['Use cap', '20 uses. Reserved uses that fail before starting still count.'],
      ['Suspension', 'Three consecutive execution failures suspend it. A success resets the counter.'],
      ['Rejection', 'Rejecting the same shape revokes its grants and blocks learning for 7 days. An ambiguous rejection (for example attached <code>-nX</code> syntax) resets the whole caller/tool/verb scope.'],
      ['Manual revoke', 'An administrator revokes one or all grants (needs a human session).'],
      ['Exception added', 'Adding a tool or verb to the exceptions revokes its existing grants.'],
      ['Namespace removed', 'Removing a namespace from the allowlist stops its grants immediately without deleting them.'],
    ])],
    ['example', 'Worked example', paragraph('A job runner repeatedly cleans finished jobs in namespace <code>splicedock</code> (allowlisted). Each call passes the same kind of context.') + terminal('Three approvals, then automatic', [
      'kubectl delete job grantprobe-a -n splicedock   # human approves, succeeds   (1/3)',
      'kubectl delete job grantprobe-b -n splicedock   # human approves, succeeds   (2/3)',
      'kubectl delete job grantprobe-c -n splicedock   # human approves, succeeds   (3/3)',
      '  -> grant created: prefix "grantprobe-", 3 days, 20 uses',
      'kubectl delete job grantprobe-d -n splicedock   # runs automatically',
      'kubectl delete job other-x -n splicedock        # prefix differs: human',
      'kubectl delete deployment grantprobe-z ...      # destructive: human',
    ].join('\n')) + paragraph('This is the live end-to-end test: the fourth call produced <code>approval bypass</code> and <code>approval consumed</code> with no <code>pending</code> entry, while the destructive deployment delete still created a pending approval.')],
    ['operate', 'Inspect and control grants', paragraph('In the admin panel open <strong>Approvals → Automatic approvals</strong> to see each grant’s prefix, uses, last use and expiry, to revoke one or all, and to manage exceptions.') + table(['Endpoint', 'Purpose'], [
      ['<code>GET /api/v1/grants</code>', 'List grants.'],
      ['<code>POST /api/v1/grants/:id/revoke</code>', 'Revoke one grant; id <code>all</code> revokes every grant. Needs an authenticated human WebAuthn session.'],
      ['<code>POST /api/v1/grant-exceptions</code>', 'Add or remove an exception (<code>tool</code>, optional <code>verb_path</code>).'],
    ])],
    ['logs', 'Reading the logs', table(['Log line', 'Meaning'], [
      ['<code>approval pending</code>', 'A human is needed.'],
      ['<code>grant promotion evidence</code>', '<code>approvals</code> candidates, <code>consistent</code> kept. Learning needs <code>consistent</code> ≥ threshold.'],
      ['<code>grant promotion skipped: …</code>', 'Classifier, namespace allowlist or no common name prefix.'],
      ['<code>standing grant created</code>', 'A grant now exists.'],
      ['<code>cli_passthrough approval bypass</code>', 'A grant matched and the request ran without a human.'],
      ['<code>approval consumed</code>', 'The approval was used.'],
      ['<code>grant context escalated</code>', 'Shape matched, but the context sent it to a human.'],
    ])],
    ['faq', 'Why did my request still ask for approval?', '<ul>' +
      '<li>Grants are off, or the namespace is not in <code>SPLICEDOCK_GRANT_NAMESPACES</code>.</li>' +
      '<li>No <code>approval_context</code>, or it changed style since the evidence (<code>grant context escalated</code>).</li>' +
      '<li>The operation is <code>destructive</code> or <code>unknown</code> to the classifier.</li>' +
      '<li>A flag, namespace, kind or object count differs, or a name does not start with the prefix.</li>' +
      '<li>Fewer than three successful, consistent approvals so far, or runs failed (failures are not evidence).</li>' +
      '<li>The grant expired, hit 20 uses, was suspended or revoked, or a rejection blocked the shape for 7 days.</li>' +
      '<li>The tool is strong (WebAuthn) or on the exception list.</li></ul>'],
    ['adrs', 'Design records', paragraph('The reasoning behind each rule is in the repository: ADR 0008 (learned grants), ADR 0009 (shape-only matching, deny-only context), ADR 0010 (name prefix and namespace allowlist) and ADR 0011 (operation classifier). Operator settings are also summarised in <code>docs/operations.md</code>.')],
  ];
}
