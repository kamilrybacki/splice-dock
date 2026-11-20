"""Run the three fixture providers on a Modal CPU worker with runtime egress blocked."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

import modal

HERE = Path(__file__).resolve().parent
RUNTIME = "https://github.com/ggml-org/llama.cpp/releases/download/b12483/llama-b12483-bin-ubuntu-x64.tar.gz"
SMOL = "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf"
QWEN = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
image = modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
if modal.is_local():
    repo = HERE.parents[1]
    image = (
        image.apt_install("ca-certificates", "libgomp1", "libssl3", "libzstd1", "zlib1g").run_commands(
            "mkdir -p /work && cd /work && npm install --no-audit --no-fund tsx@4.23.15 quickjs-emscripten@0.32.0",
            f"""cd /work && python -c "from urllib.request import urlretrieve as get; get('{RUNTIME}', 'llama.tar.gz'); get('{SMOL}', 'smol.gguf'); get('{QWEN}', 'qwen.gguf')" """,
            r"cd /work && printf '%s\n' '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d  smol.gguf' '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db  qwen.gguf' | sha256sum --check",
            "cd /work && tar -xf llama.tar.gz && rm llama.tar.gz",
        )
        .add_local_file(HERE / "bench.mts", "/work/experiments/code-mode-mocks/bench.mts", copy=True)
        .add_local_file(repo / "src/code-mode/executor.ts", "/work/src/code-mode/executor.ts")
    )
app = modal.App("splicedock-mock-model-suite")


@app.function(image=image, cpu=4, memory=4096, timeout=300, max_containers=1, block_network=True)
def run_models() -> dict:
    source = Path("/work/experiments/code-mode-mocks")
    servers = []
    try:
        for model, port in [("smol", 18951), ("qwen", 18952)]:
            log = Path(f"/tmp/splicedock-{model}.log")
            with log.open("wb") as stream:
                process = subprocess.Popen(
                    ["/work/llama-b12483/llama-server", "-m", f"/work/{model}.gguf",
                     "--host", "127.0.0.1", "--port", str(port), "--alias", model, "-c", "1024", "-t", "2", "-np", "1"],
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                )
            servers.append(process)
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError(log.read_text(errors="replace")[-2500:])
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1):
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError(f"Inference server on port {port} failed to start")
        run = subprocess.run(
            ["node", "--import", "tsx", str(source / "bench.mts")], cwd="/work",
            env={**os.environ, "MOCK_BENCH_BOUNDED": "1"}, capture_output=True, text=True, timeout=240,
        )
        if run.returncode:
            raise RuntimeError(run.stderr[-3000:])
        result = json.loads((source / "results-bounded.json").read_text())
        if len(result["trials"]) != 54 or not all(row["ok"] for row in result["trials"] if row["provider"] == "template"):
            raise RuntimeError("The benchmark did not complete its template control cases")
        return result
    finally:
        for process in servers:
            process.terminate()
            process.wait(timeout=15)


@app.local_entrypoint()
def main():
    result = run_models.remote()
    (HERE / "modal-model-results.json").write_text(json.dumps(result, indent=2) + "\n")
    for model in ("template", "smol", "qwen"):
        rows = [row for row in result["trials"] if row["provider"] == model]
        print(f"{model}: {sum(row['ok'] for row in rows)}/{len(rows)} successful")
