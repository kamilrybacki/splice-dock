FROM node:22-slim AS build-node
WORKDIR /app
COPY package*.json tsconfig.json ./
# better-sqlite3 13 ships prebuilt binaries and always loads them, but npm
# still runs `node-gyp rebuild` for it (npm/cli#9837), which needs Python and a
# C++ compiler that this image does not have. Skip install scripts, then run
# the only other one this tree needs (esbuild's binary check).
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY src ./src
RUN npm run build

FROM node:22-slim
# gh is pinned to the release the built-in gh policy tables were verified
# against. Keep in sync with PINNED_GH_VERSION (src/domain/cli/gh-version.ts);
# tests/unit/drivers/gh-version-pin.test.ts enforces it.
ARG GH_VERSION=2.102.0
# kubectl is pinned to the target cluster version (bump alongside cluster upgrades).
# Digests from https://dl.k8s.io/release/v1.32.3/bin/linux/<arch>/kubectl.sha256.
ARG KUBECTL_VERSION=v1.32.3
# Digests from gh_2.102.0_checksums.txt, cross-checked with a second download.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      curl ca-certificates git python3 python3-pip tini tar openssh-client; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
      arm64) sha256=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    archive="gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    install_dir="$(mktemp -d)"; \
    curl --fail --silent --show-error --location --retry 3 \
      -o "$install_dir/$archive" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$archive"; \
    printf '%s  %s\n' "$sha256" "$install_dir/$archive" | sha256sum --check --strict; \
    tar -xzf "$install_dir/$archive" -C "$install_dir" --strip-components=2 \
      "gh_${GH_VERSION}_linux_${arch}/bin/gh"; \
    install -m 0755 "$install_dir/gh" /usr/local/bin/gh; \
    gh --version | grep -q "^gh version ${GH_VERSION} "; \
    case "$arch" in \
      amd64) k_sha=ab209d0c5134b61486a0486585604a616a5bb2fc07df46d304b3c95817b2d79f ;; \
      arm64) k_sha=6c2c91e760efbf3fa111a5f0b99ba8975fb1c58bb3974eca88b6134bcf3717e2 ;; \
    esac; \
    curl --fail --silent --show-error --location --retry 3 \
      -o "$install_dir/kubectl" \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    printf '%s  %s\n' "$k_sha" "$install_dir/kubectl" | sha256sum --check --strict; \
    install -m 0755 "$install_dir/kubectl" /usr/local/bin/kubectl; \
    rm -rf "$install_dir" /var/lib/apt/lists/*

# ssh wrapper: pins -F to a mounted config (/home/node/.ssh/config).
# The chart's cli_passthrough install script symlinks these into SPLICEDOCK_BIN.
RUN mkdir -p /opt/operator-bin \
    && printf '#!/bin/sh\nexec /usr/bin/ssh -F /home/node/.ssh/config "$@"\n' > /opt/operator-bin/ssh \
    && ln -s /usr/bin/ssh-keygen /opt/operator-bin/ssh-keygen \
    && chmod 0755 /opt/operator-bin/ssh

# uv and uvx (for Python MCP servers such as serena), pinned by index digest.
COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /uvx /usr/local/bin/

# codex CLI (OpenAI), pinned so a rebuild of the same tag installs the same CLI.
ARG CODEX_VERSION=0.172.0
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY --from=build-node /app/node_modules ./node_modules
COPY --from=build-node /app/package.json ./package.json
COPY --from=build-node /app/dist ./dist
COPY site/assets/splicedock-mark.svg site/assets/space-grotesk-latin-500.woff2 site/assets/space-grotesk-latin-700.woff2 site/assets/space-mono-latin-400.woff2 site/assets/space-mono-latin-700.woff2 site/assets/OFL-SpaceGrotesk.txt site/assets/OFL-SpaceMono.txt ./site/assets/

# Credential minting adapters used by `credential_providers` entries (type: command).
# Plain .mjs: run by the image's node, no build step, no extra dependency.
COPY scripts/mint ./scripts/mint

# Entrypoint: tini (PID 1, signal forwarding) -> entrypoint.sh -> node.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8788 8789
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
