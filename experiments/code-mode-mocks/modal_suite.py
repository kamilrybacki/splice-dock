"""Ephemeral, network-blocked Modal replay tests. Upload only these test sources."""
import json
import os
from pathlib import Path
import subprocess

import modal

HERE = Path(__file__).resolve().parent
# Modal imports this module under /root in the remote runtime. Resolve mounts locally only.
image = modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
if modal.is_local():
    repo = HERE.parents[1]
    image = (
        image.run_commands("mkdir -p /work && cd /work && npm install --no-audit --no-fund tsx@4.23.15 quickjs-emscripten@0.32.0")
        .add_local_file(repo / "src/code-mode/executor.ts", "/work/src/code-mode/executor.ts")
        .add_local_file(repo / "src/code-mode/preflight.ts", "/work/src/code-mode/preflight.ts")
        .add_local_file(HERE / "replay-check.mts", "/work/experiments/code-mode-mocks/replay-check.mts")
    )
app = modal.App("splicedock-replay-suite")


@app.function(image=image, cpu=1, memory=1024, timeout=90, max_containers=4, block_network=True)
def check(shard: int) -> dict:
    run = subprocess.run(
        ["node", "--import", "tsx", "experiments/code-mode-mocks/replay-check.mts"],
        cwd="/work",
        env={**os.environ, "REPLAY_REPETITIONS": "2"},
        check=False,
        capture_output=True,
        text=True,
        timeout=65,
    )
    if run.returncode:
        raise RuntimeError(run.stderr[-3000:])
    result = json.loads(run.stdout)
    return {"shard": shard, "node": subprocess.check_output(["node", "--version"], text=True).strip(), **result}


@app.local_entrypoint()
def main(shards: int = 8):
    results = list(check.map(range(shards)))
    report = {"platform": "modal", "shards": results, "passed": sum(x["passed"] for x in results)}
    (HERE / "modal-results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Modal replay suite: {report['passed']} passing cases across {shards} shards")
