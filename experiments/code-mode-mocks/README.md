# Code Mode mock response experiment

The same Code Mode executor runs against a test adapter that emits real HTTP
requests to a loopback simulator. The simulator records method, path, parsed JSON
body, and response status without forwarding requests. This harness does not
install a production egress proxy or enforce an OS network sandbox.

The provider contract is `generate({ scenario, seed }) → { summary }`. A template
or a local chat-completions service supplies the synthetic text before each
run. The HTTP simulator is deterministic and owns the state, status codes, and
IDs. State is reset between trials. The fixture can be generated on the first
request in a future integration, then validated and cached under the run and
resource IDs. A timeout or rejected response can select the template fixture.

Three paths were checked with six seeds per provider: a missing ticket (GET,
POST, GET of the returned ID), an existing ticket (two GETs), and a 503 error.
A trial counted as successful only if the fixture passed validation and the
observed requests and workflow result matched the expected scenario. The
evaluation does not score the quality of the generated prose.

## Reproduce

Use llama.cpp build b12483 and Node 26.13.1, with the repository's dependencies
installed. The model files used were:

- `bartowski/SmolLM2-135M-Instruct-GGUF`, Q4_K_M, SHA-256
  `2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d`.
- `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, Q4_K_M, SHA-256
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.

Start local servers separately:

```sh
llama-server -m smol.gguf --host 127.0.0.1 --port 18951 --alias smol -c 1024 -t 2 -np 1
llama-server -m qwen.gguf --host 127.0.0.1 --port 18952 --alias qwen -c 1024 -t 2 -np 1
```

From the repository root:

```sh
node --import tsx experiments/code-mode-mocks/bench.mts
MOCK_BENCH_BOUNDED=1 node --import tsx experiments/code-mode-mocks/bench.mts
```

Results are written to `results.json` and `results-bounded.json`.
The second run constrains the generated field to 1–120 characters in the JSON
schema and validates that limit locally. Both runs cap generation at 80 tokens.

## Modular integration

Configure the simulator and guard independently. A fixture provider can be a
built-in template or a local service configured by endpoint, model, schema and
timeout. Validate its output again in the gateway. For a supported route,
a failed generation can fall back to the template. An unsupported route yields
an incomplete simulation. The model supplies fields, while simulator code
selects the route, status, identifiers, and state transitions.

Keep the inference client outside the trial runner. The runner's tool adapters
should only reach the capture service, which owns the mock backend and calls
the configured fixture provider. Send a redacted trace and the original task
to the separately configured guard. In this prototype these are independent
calls. Production authorization must check the real request before forwarding.

The split is inspired by [DeepFellow's experimental guards](https://docs.deepfellow.ai/docs/latest/plugins),
which invoke an external service and select a workflow per guard. The prototype
uses the OpenAI-compatible chat shape for fixture generation. A DeepFellow
endpoint would need separate verification of the requested structured output
and its model routing.

`classifier-example.json` demonstrates the same captured POST checked against
two different user tasks using Jev 1.14.0. This pair illustrates the interface
and does not estimate guard accuracy or establish an acceptance threshold.

## Opt-in preflight

The regular MCP entry point supports `SPLICEDOCK_CODE_MODE_PREFLIGHT=observe`
or `enforce` for authenticated callers with Code Mode enabled. Without the
variable, the gateway uses its existing workflow behavior. Set
`SPLICEDOCK_CODE_MODE_PREFLIGHT_PROFILES` to an explicit comma-separated profile
list. Unlisted profiles retain their workflow behavior. Configure both
`SPLICEDOCK_CODE_MODE_MOCK_URL` and `SPLICEDOCK_CODE_MODE_REVIEW_URL` on loopback.

- The mock endpoint receives `{ request: { tool, method, url, body? }, runId }`
  and returns `{ status, body }`, where body is a string. Unknown routes must
  return an error from the sidecar itself, so the gateway marks the trace
  incomplete. A simulated upstream error can instead be returned in the envelope.
- The review endpoint receives `{ code, profile, requests }`. The service is
  trusted and must return an explicit `{ "decision": "allow" }` for replay.
  Any other result or transport failure prevents replay. Only configure
  a reviewer that independently enforces action permissions. Never translate a
  low classifier score into permission. Treat payloads and code as sensitive.
  Neither endpoint receives the live credential header from the HTTP adapter.
- Observe mode never forwards. Enforce mode re-executes the snippet and matches
  each HTTP call against the reviewed ordered trace before resolving credentials
  and forwarding. Retries and redirects are disabled. If the live execution
  diverges, already forwarded requests may have completed.
- CLI records the command, resolved arguments and working directory. CLI
  passthrough still requires its normal live policy checks and approvals.
  During simulation neither invokes a process or resolves its credentials.
- The MCP proxy records the destination and the actual `tools/call` parameters.
  Guarded replay requires an already connected Streamable HTTP driver. It
  validates the outgoing JSON-RPC POST and refuses redirects, reconnect and
  retries. The older SSE transport is unsupported in guarded mode.
- Both driver types use the same mock endpoint. Return
  `{ "result": { "content": [{ "type": "text", "text": "fixture" }] } }`
  for a known operation. The captured item carries a `driver` discriminator.
  No shell or live MCP calls should be used to produce a fixture.
- The guards operate at the gateway boundary. Network calls made by spawned
  CLI programs or upstream MCP servers are outside their scope. The reviewer
  does not receive a trusted original task from the current MCP request.


For a local demo, run `node experiments/code-mode-mocks/mock-service.mjs`. The
service defaults to a template, or accepts `MOCK_MODEL_ID` and `MOCK_MODEL_PORT`
for a local chat server. It generates only the summary on first use, caches it
within the run and uses the template if inference fails. It simulates the
fictional ticket routes and explicit demo operations (`demo__echo`,
`demo__help`, `demo__read`). Its `/review` endpoint always denies forwarding.

Run the replay matrix locally with
`REPLAY_REPETITIONS=4 node --import tsx experiments/code-mode-mocks/replay-check.mts`.
With an authenticated test Modal workspace, run
`modal run experiments/code-mode-mocks/modal_suite.py` for 256 assertions across
eight shards, or `modal run experiments/code-mode-mocks/modal_models.py` for the
54 bounded fixture trials. Inputs use synthetic fixtures. The remote runtime
blocks network access and uses loopback for both mock HTTP and model inference.
Images retrieve the public model files during the build, before the network
restriction applies.
