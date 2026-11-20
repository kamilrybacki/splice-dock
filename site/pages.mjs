export const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export const terminal = (label, value) => `<figure class="terminal"><figcaption><span>${escape(label)}</span><span aria-hidden="true">[ _ ] [ + ] [ x ]</span></figcaption><pre><code>${escape(value)}</code></pre><button class="copy" type="button" aria-label="Copy code">Copy</button></figure>`;
const section=(id,title,body)=>`<section id="${id}" class="doc-section"><h2><a href="#${id}">${title}</a></h2>${body}</section>`;
const table=(heads,rows)=>`<div class="table-scroll"><table><thead><tr>${heads.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const paragraph = text => '<p>' + text + '</p>';

function page(slug, title, description, heading, art, intro, sections) {
  return {
    slug, title, nav: title, description, heading, art, kicker: 'USER GUIDE',
    body: '<p class="lead">' + intro + '</p>' + sections.map(args => section(...args)).join(''),
  };
}

function toolCall(name, args, id = 1) {
  return terminal('MCP tools/call request', JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, null, 2));
}

function driverExample(scenario, config, name, args, output, extra = '') {
  return paragraph(scenario) + terminal('Gateway configuration', config) +
    terminal('Add this tool to the profile manifest', 'tools:\n  - ' + name) +
    toolCall(name, args) + terminal('Example result text', output) + extra;
}

function driverExamples() {
  const examples = [
    ['mcp', 'mcp_proxy', 'MCP server', 'Connect an existing MCP server.', driverExample(
      'The local demo server exposes <code>lookup_product</code>. Splicedock adds the backend name as a prefix, so the client calls <code>catalog__lookup_product</code>.',
      `tools:
  - type: mcp_proxy
    name: catalog
    service_dns: 127.0.0.1
    port: 9001
    transport: streamable_http`,
      'catalog__lookup_product', { sku: 'P-100' }, 'P-100: Desk lamp',
      paragraph('Use the hostname as seen from the gateway. The configured host and port form an HTTP URL ending in <code>/mcp</code> for Streamable HTTP or <code>/sse</code> for SSE.'),
    )],
    ['http', 'http', 'HTTP endpoint', 'Expose one operation from a web API.', driverExample(
      'Look up a product in the demo API by SKU. The gateway URL-encodes the <code>sku</code> argument and puts it in the path.',
      `tools:
  - type: http
    namespace: catalog
    name: product
    description: Look up a product by SKU
    method: GET
    url: http://127.0.0.1:9001/products/{sku}
    params:
      - name: sku
        in: path
        required: true
    auth: { type: none }`,
      'catalog__product', { sku: 'P-100' }, '{"sku":"P-100","name":"Desk lamp"}',
      '<details><summary>Authenticate to an HTTP backend</summary>' +
        paragraph('For a backend that requires a bearer token, replace the tool’s <code>auth</code> block with the following and set <code>CATALOG_API_TOKEN</code> in the gateway environment. Point <code>url</code> at that API, using HTTPS for a remote backend.') +
        terminal('HTTP tool authentication', 'auth:\n  type: bearer\n  token:\n    from: env:CATALOG_API_TOKEN') + '</details>',
    )],
    ['fixed-cli', 'cli', 'Fixed CLI command', 'Run a predefined command with a fixed argument template.', driverExample(
      'Expose <code>node --version</code> as a tool with no arguments. Node.js must be on the gateway’s <code>PATH</code>. If you are using the <a href="start.html">Quickstart</a> configuration, keep its existing entry for this tool.',
      `server:
  cli_whitelist: [node]
tools:
  - type: cli
    namespace: demo
    name: version
    description: Read the installed Node.js version
    command: node
    args: ["--version"]`,
      'demo__version', {}, 'v22.14.0',
      paragraph('Compare the result with <code>node --version</code> in the gateway environment.'),
    )],
    ['cli', 'cli_passthrough', 'CLI passthrough', 'Accept an argument array and apply a policy before running it.', driverExample(
      'Expose Git and allow exactly one argument, <code>version</code>. Run <code>command -v git</code> in the gateway environment and use the resulting executable path in both YAML fields.',
      `server:
  cli_whitelist: [/usr/bin/git]
tools:
  - type: cli_passthrough
    name: git
    description: Show the installed Git version
    command: /usr/bin/git
    policy:
      allow_subcommands: [version]
      max_args: 1`,
      'git__run', { args: ['version'] }, 'git version 2.43.0',
      paragraph('For a local setup, set a writable binary directory before starting the gateway.') +
        terminal('Terminal', 'export SPLICEDOCK_BIN="$PWD/.data/bin"') +
        '<details><summary>Check that the policy denies another command</summary>' +
        toolCall('git__run', { args: ['status'] }, 2) +
        terminal('Policy error text', 'Denied by policy.allow_subcommands') +
        paragraph('The gateway returns a tool error and does not start Git. See <a href="policies.html#order">policy evaluation order</a> for rule precedence.') + '</details>',
    )],
  ];

  return table(['Driver', 'Use it for'], examples.map(([id, driver, , purpose]) => [
    '<a href="#' + id + '"><code>' + driver + '</code></a>', purpose,
  ])) +
    paragraph('Start from the <a href="start.html#config">Quickstart configuration</a>. Merge the shown keys into the existing YAML, keeping other tools and allowlist entries. Restart the gateway after editing it. If the profile already exists, update its tool list in the <a href="profiles.html#editor">profile editor</a>. Connect with a <a href="connect.html#create-token">token for that profile</a>, then call the named tool in your MCP client. The JSON snippets show the request sent by the client.') +
    '<details><summary>Start the local MCP and HTTP demo server</summary>' +
    paragraph('From the repository checkout, after installing dependencies, run this command in a separate terminal. The <a href="examples/driver-backends.mjs">demo server source</a> binds to <code>127.0.0.1:9001</code>. Start it before the gateway on the same machine. Stop it with Ctrl+C.') +
    terminal('Terminal', 'node site/examples/driver-backends.mjs') + '</details>' +
    '<div data-driver-examples>' +
    '<div class="driver-tabs" role="tablist" aria-label="Driver examples" hidden>' +
    examples.map(([id, driver]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="${id}">${driver}</button>`).join('') +
    '</div>' +
    examples.map(([id, , title, , body]) => section(id, title, body)).join('') +
    '</div>';
}

export function makePages(config, quickstart) {
  return [
    page('index', config.name, 'A single MCP gateway for tools, profiles, policies, and Code Mode.', config.tagline, 'gate-120.svg',
      'Connect your agents to one gateway and manage which tools each agent can use.', [
      ['flow', 'One path to your tools', paragraph('Agents connect over MCP. Splicedock routes calls to MCP servers, HTTP APIs, and CLI tools.')],
      ['features', 'Get started', '<ul class="checklist"><li><a href="start.html">Run a local example</a></li><li><a href="connect.html">Connect an MCP client</a></li><li><a href="profiles.html">Configure access profiles</a></li><li><a href="code-mode.html">Run a Code Mode workflow</a></li></ul>'],
      ['name', 'Version 1.0', paragraph('This guide describes Splicedock 1.0 and its MCP, HTTP, and CLI integrations.')],
      ['boundary', 'Where policy applies', paragraph('Gateway policies apply to calls routed through Splicedock. Local files, a client shell, and permissions within backend services need their own controls.')],
    ]),
    page('start', 'Quickstart', 'Start Splicedock locally, authenticate, and verify your first tool result.', 'From configuration to your first call.', 'terminal-80.svg',
      'This example exposes the installed Node.js version. It needs no external backend.', [
      ['requirements', '1. Prepare the environment', paragraph('Install Git, Node.js 22, and npm. Install dependencies under the same Node version that runs the gateway so the native SQLite module is compatible.') +
        terminal('Terminal', 'git clone ' + config.repository + '.git ' + config.slug + '\ncd ' + config.slug + '\nnpm ci\nnpm run build')],
      ['config', '2. Save the configuration', paragraph('Copy the demo configuration from the checkout. The <code>demo</code> profile exposes <code>demo__version</code> and enables Code Mode. The example disables strong consent for this read-only demo.') + terminal('Terminal', 'cp site/examples/quickstart.yaml splicedock.local.yaml') + '<details><summary>View the example configuration</summary>' + terminal('Example configuration', quickstart) + '</details>'],
      ['run', '3. Start the application', terminal('Terminal', [
        'export SPLICEDOCK_CONFIG="$PWD/splicedock.local.yaml"',
        'export SPLICEDOCK_DB_PATH="$PWD/.data/splicedock.db"',
        'export SPLICEDOCK_ADMIN_TOKEN="$(node -e \'console.log(require("node:crypto").randomBytes(32).toString("hex"))\')"',
        'node dist/main.js &',
        'gateway_pid=$!',
      ].join('\n')) + paragraph('Run the next command in the same terminal so it can use the administrator token. The gateway serves MCP on port <code>8788</code> and the Admin API on <code>8789</code>. For this example use a local machine with those ports available.')],
      ['next', '4. Make your first tool call', paragraph('The example issues a short-lived profile token, lists tools, and calls <code>demo__version</code> over MCP.') +
        terminal('Terminal', 'node site/examples/first-call.mjs') +
        terminal('Example output', 'demo__version: v22.14.0') +
        paragraph('The version should match <code>node --version</code> in the same terminal. The example revokes its token when it finishes. To connect your own client, <a href="connect.html#create-token">create a separate profile token</a>.')],
      ['stop', '5. Stop the demo', paragraph('To stop the local gateway, run the following command in the terminal where it started.') +
        terminal('Terminal', 'kill "$gateway_pid"')],
    ]),
    page('connect', 'MCP clients and tokens', 'Create, rotate, and revoke a token for an MCP client.', 'Connect with a profile token.', 'key-56.svg',
      'Use an MCP client that supports Streamable HTTP and an Authorization header.', [
      ['tokens', 'Two kinds of token', table(['Token', 'Purpose'], [['Administrator', 'Manage profiles, tokens, and approvals.'], ['Profile', 'Authenticate an MCP client and select its permitted tools.']])],
      ['create-token', 'Create a profile token', paragraph('The Quickstart creates the <code>demo</code> profile. To connect with a different profile, replace its name in the request. Run the following with your administrator token.') + terminal('Admin API', [
        'curl --fail-with-body -X POST http://127.0.0.1:8789/api/v1/profile-tokens \\',
        '  -H "Authorization: Bearer $SPLICEDOCK_ADMIN_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"profile":"demo","agent":"my-agent","expires_in_seconds":3600}\'',
      ].join('\n')) + paragraph('HTTP 201 returns <code>data.token</code> and <code>data.id</code>. Save the raw token in your client’s secret store when it is issued.')],
      ['client', 'Configure the client', terminal('Connection settings', 'transport: Streamable HTTP\nurl: http://127.0.0.1:8788/mcp\nheader: Authorization: Bearer <PROFILE_TOKEN>') + paragraph('The exact configuration field names depend on your client. Reconnect after changing them.')],
      ['selection', 'How the profile is selected', paragraph('The bearer token selects its bound profile. Connect to <code>/mcp</code> with <code>Authorization: Bearer &lt;PROFILE_TOKEN&gt;</code>. With <code>server.require_profile_token: true</code>, a missing, unknown, expired, or revoked token returns HTTP 401.')],
      ['rotate', 'Rotate or revoke a token', table(['Action', 'Endpoint'], [
        ['List tokens', '<code>GET /api/v1/profile-tokens</code>'],
        ['Rotate', '<code>POST /api/v1/profile-tokens/:id/rotate</code>'],
        ['Revoke', '<code>POST /api/v1/profile-tokens/:id/revoke</code> with reason <code>manual</code> or <code>compromised</code>'],
      ]) + paragraph('Rotation returns HTTP 201. Save the new <code>data.token</code> in your client’s secret store and reconnect. Keep <code>data.id</code> for the next rotation or revocation. Send <code>{"reason":"manual"}</code> to revoke a token. HTTP 204 confirms revocation. Admin UI mutations using a session cookie require <code>X-Splicedock-CSRF</code>.')],
    ]),
    page('profiles', 'Profiles and YAML', 'Configure the tool catalog, Code Mode, and credential bindings.', 'Give each agent a tool catalog.', 'filter-40.svg',
      'A profile limits the names a client can discover and call. Tool policies still apply to individual calls.', [
      ['manifest', 'Profile manifest', terminal('Existing profile', 'tools:\n  - "demo__version"\nenable_code_mode: true\ncredentials: {}') + paragraph('Use exact tool names or globs. A new manifest includes <code>name</code>. Code Mode has an explicit flag and is disabled by default.')],
      ['editor', 'Edit in the browser', paragraph('Open <code>/admin/profiles</code>, select a profile, edit the YAML, and save. The editor validates the document and retains its comments.')],
      ['conflicts', 'Revisions and conflicts', paragraph('Saves include <code>base_revision</code>. If somebody else has saved since you opened the editor, HTTP 409 asks you to reload and reconcile the changes.')],
      ['storage', 'Storage and restart', paragraph('YAML configuration seeds missing profiles at startup. The catalog keeps committed manifests in the database. A deleted configuration profile stays deleted across restarts.')],
      ['api', 'Manifest API', paragraph('List profiles with <code>GET /api/v1/profiles</code>. Request the YAML catalog with <code>?format=yaml</code>. Use the profile editor for revision-aware updates.')],
    ]),
    page('tools', 'Backends and tools', 'Connect MCP, HTTP and CLI backends.', 'Bring your tools to one endpoint.', 'toolbox-80.svg',
      'Choose a driver for the system you are integrating and add its exposed names to the appropriate profiles.', [
      ['drivers', 'Choose a driver', driverExamples()],
    ]),
    page('policies', 'Policies and approvals', 'Configure CLI rules and request approval for individual operations.', 'Check the operation before it runs.', 'shield-56.svg',
      'CLI passthrough checks the argument array before starting a process.', [
      ['order', 'Evaluation order', paragraph('The gateway checks the argument limit, deny rules, allow rules, and required arguments before handling approval. A hard denial takes precedence.')],
      ['example', 'Policy example', terminal('kubectl tool policy', 'policy:\n  max_args: 64\n  deny_subcommands: [delete]\n  approval_subcommands: [apply]\n  require_any_of:\n    - ["--namespace", "-n"]\n  audit: true') + paragraph('<code>delete</code> is denied. An <code>apply</code> request with a namespace flag requests approval.')],
      ['approval', 'Request and consume approval', paragraph('The tool returns <code>approval_id</code> and <code>expires_at</code>. Wait through <code>approvals__wait</code> for up to 120 seconds per call. After approval, submit the same operation with the same token, profile, argument array, and resolved working directory before expiry. Each approval can be used once.') + terminal('Arguments for approvals__wait', '{"id":"<APPROVAL_ID>","timeout_s":120}')],
      ['strong', 'Strong approval with WebAuthn', paragraph('Set <code>server.consent.rp_id</code>, its HTTPS <code>origin</code>, and the trusted hardware attestation roots. Configure the public origin used by the browser.')],
      ['grants', 'Optional learned grants', paragraph('Enable <code>SPLICEDOCK_GRANTS=1</code> to permit eligible operations after repeated successful approvals in similar contexts. Review or revoke grants in the admin panel.')],
    ]),
    page('credentials', 'Backend credentials', 'Use stored or short-lived credentials to reach a backend.', 'Keep backend credentials in the gateway.', 'key-56.svg',
      'The agent uses a profile token. Splicedock selects the backend credential for the call.', [
      ['resolution', 'Credential selection', paragraph('Splicedock checks the profile binding, the deployment defaults, and the backend configuration in that order.')],
      ['env', 'Existing secret', terminal('Profile fragment', 'credentials:\n  gh:\n    env:\n      - name: GH_TOKEN\n        from: env:GH_TOKEN_DEMO') + paragraph('Declare <code>gh</code> first and set the referenced variable on the gateway. Use an environment or Vault reference to keep the raw secret out of the YAML.')],
      ['mint', 'Issue credentials on demand', paragraph('Define a provider in <code>credential_providers</code> and refer to it with <code>mint</code> in the profile. On first use the broker requests a credential, caches it, and refreshes it before expiry. Choose the backend credential’s minimum required scope.') + terminal('Profile binding', 'credentials:\n  gh:\n    env:\n      - name: GH_TOKEN\n        mint: github-app') + paragraph('The server must define the named <code>github-app</code> provider. It can run a configured helper that returns a GitHub App installation token.')],
    ]),
    page('code-mode', 'Code Mode', 'Run several tool calls in one JavaScript workflow.', 'Compose tools in a sandbox.', 'terminal-80.svg',
      'Give the gateway an async JavaScript function body. It runs the workflow and returns the result and a call summary.', [
      ['enable', 'Enable the tool', terminal('Profile manifest', 'tools:\n  - "demo__version"\nenable_code_mode: true\ncredentials: {}') + paragraph('The Quickstart enables Code Mode on <code>demo</code>. For another profile, set <code>enable_code_mode: true</code>, save, then refresh the client’s MCP catalog.')],
      ['first-workflow', 'Run a workflow', paragraph('Set the <code>code</code> argument on <code>code_mode__execute</code>. This example uses the <a href="start.html">quickstart</a>.') + terminal('JavaScript', 'const response = await tools.call("demo__version", {});\nreturn { ok: !response.isError, output: response.content };')],
      ['discovery', 'Discover and call tools', table(['API', 'Returns'], [['<code>tools.list()</code>', 'Names and descriptions.'], ['<code>tools.search(query)</code>', 'Matching tools and schemas.'], ['<code>await tools.call(name, args)</code>', 'An MCP tool result.']]) + paragraph('Use <code>Promise.all</code> to run independent reads concurrently. Check <code>isError</code> and use the backend’s actual response shape.')],
      ['limits', 'Sandbox and limits', table(['Resource', 'Limit'], [['Input and final result', '64 KiB each'], ['VM memory / stack', '16 MiB / 512 KiB'], ['JS execution turn / workflow', '1 s / 30 s'], ['Tool calls / concurrent calls', '50 / 4'], ['Tool response', '4 MiB']]) + paragraph('The QuickJS runtime has no direct filesystem, network, process, module loader, or timers. Code Mode cannot invoke itself.')],
      ['http-preflight', 'Simulate operations before execution', paragraph('To configure preflight, run a trusted local simulator and a separate reviewer, then select the profiles that should use them. Preflight prepares each HTTP request, MCP call, or CLI command and obtains a fixture from the simulator. The reviewer receives the snippet and trace. In enforcement mode, the gateway checks each live operation against the approved trace before sending or running it.') + terminal('Instance settings', [
        'SPLICEDOCK_CODE_MODE_PREFLIGHT=observe',
        'SPLICEDOCK_CODE_MODE_PREFLIGHT_PROFILES=demo',
        'SPLICEDOCK_CODE_MODE_MOCK_URL=http://127.0.0.1:18953/mock',
        'SPLICEDOCK_CODE_MODE_REVIEW_URL=http://127.0.0.1:18953/review',
      ].join('\n')) + paragraph('Observe mode stops at review. Use enforce mode with a trusted review service that independently enforces operation permissions. A model score alone cannot authorize an operation. Use a profile token. HTTP, fixed CLI, CLI passthrough, and already connected Streamable HTTP MCP are supported. CLI passthrough applies its ordinary live policy and approvals. SSE is unsupported. Traffic produced inside a CLI process or remote MCP backend is outside this check.')],
      ['errors', 'Errors, approvals, and retries', paragraph('Check each tool result and await all started operations. A later failure, timeout, or a changed preflight trace cannot roll back a call that has already started. A separate retry for an approved operation must obey the original policy.')],
    ]),
    page('webui', 'Admin UI and observability', 'Use the admin panel, audit log, and Prometheus metrics.', 'See what your agents called.', 'toolbox-80.svg',
      'The admin application normally listens on port 8789. Sign in with the administrator token.', [
      ['login', 'Sign in', paragraph('Open <code>/admin/login</code> on the admin origin. The browser uses a session cookie. API clients can send the administrator bearer token.')],
      ['views', 'Admin views', table(['View', 'Use'], [['<code>/admin/</code>', 'Tool configuration and status.'], ['<code>/admin/profiles</code>', 'Profile manifests.'], ['Audit', 'Recent decisions.'], ['Approvals', 'Pending operations and learned grants.']])],
      ['metrics', 'Prometheus metrics', paragraph('Scrape <code>/metrics</code> on the admin port. Configure <code>server.metrics_token_env</code> for a separate metrics bearer token if required. Process counters can reset on restart.')],
      ['pwa', 'Phone app (PWA)', paragraph('<code>/admin/swipe</code> is an installable progressive web app. Open it on your phone and use <strong>Add to home screen</strong> (Android: Install app). It then runs full screen as <em>Splicedock approvals</em>: swipe a card right to approve, left to reject.') + table(['Asset', 'Path'], [['Web app manifest', '<code>/admin/manifest.webmanifest</code>'], ['Service worker', '<code>/admin/sw.js</code> (scope <code>/admin/</code>)'], ['Icons', '<code>/admin/icon-180.png</code>, <code>icon-192.png</code>, <code>icon-512.png</code>']]) + paragraph('The service worker is network-only and caches nothing, because approvals are live state. It exists to make the app installable and to show Web Push alerts. These assets carry no user data and are served without a session; the edge proxy still protects the admin host, and signing in and WebAuthn rules apply as usual once you open the app.')],
      ['phone', 'Phone notifications', paragraph('Tap <strong>enable notifications</strong> in the app for a Web Push alert on each new pending approval (on iOS, install the app to the home screen first). Configure Web Push with <code>SPLICEDOCK_VAPID_PUBLIC_KEY</code>, <code>SPLICEDOCK_VAPID_PRIVATE_KEY</code>, and <code>SPLICEDOCK_VAPID_SUBJECT</code>. Strong approvals still follow the WebAuthn policy.')],
    ]),
    page('troubleshooting', 'Troubleshooting', 'Diagnose common connection, catalog, policy, YAML, and runtime errors.', 'Trace a problem to its source.', 'terminal-80.svg',
      'Start with the HTTP status or tool error and check the active profile.', [
      ['401', 'MCP returns HTTP 401', paragraph('Check the profile bearer token, expiry, and revocation status. Use the MCP endpoint and a Streamable HTTP client.')],
      ['catalog', 'Missing tool or empty catalog', paragraph('Check the token’s profile, tool name and profile patterns. Refresh the client catalog after edits. Code Mode must be enabled explicitly.')],
      ['denied', 'Denied by policy or broker_required', paragraph('Read the rule named in the tool result. A hard denial requires a policy change or a different permitted operation. Use the applicable broker for operations it owns.')],
      ['approval', 'Approval did not start the operation', paragraph('Retry the exact operation after approval and before expiry. Keep your token, profile, arguments, and working directory the same.')],
      ['yaml', 'YAML save returns 409 or 422', paragraph('For 409, reload the manifest and reconcile concurrent edits. For 422, fix the reported YAML or schema error.')],
      ['startup', 'Application fails to start', paragraph('Check the configured HTTPS consent origin and RP ID, SQLite write permissions, and the Node.js version used to install native modules. Use a shared PostgreSQL database for multiple replicas.')],
      ['timeout', 'Code Mode timed out', paragraph('Reduce the number of calls and the result size. Check the call summary before retrying because a tool may already have completed.')],
      ['report', 'Report a problem', paragraph('Include the version, runtime, tool name, error, and a redacted configuration excerpt. Keep credentials and private payloads out of the report.')],
    ]),
  ];
}
