# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-24

### Added

- End-to-end smoke tests in `scripts/smoke/`. CI installs the packed npm
  package in a fresh container and runs the Quickstart against it, and on pull
  requests starts the built image with SQLite and with PostgreSQL.

### Changed

- The image runs the gateway as the `node` user (UID 1000) instead of root.
  When started as root, the entrypoint gives `/var/splicedock/data` and
  `/var/splicedock/bin` to that user, including volumes written by v1.0.0,
  then drops privileges. Files mounted into the container must be readable by
  UID 1000. Without `CAP_SETUID` and `CAP_SETGID` (for example
  `--cap-drop ALL`) it logs a warning and keeps running as root. `--user` and
  Kubernetes `runAsUser` work as before.
- The image pins uv 0.13.9 by digest and the codex CLI to 0.172.0; it used to
  install the latest of each and ignore a failed codex install.
  `/root/.local/bin` is no longer on `PATH`.

## [1.0.0] - 2026-11-24

First public release.

### Added

- npm package `splicedock` with a `splicedock` command. Run it with
  `npx splicedock` or install it with `npm install -g splicedock`.
  `splicedock db migrate-sqlite-to-pg` runs the SQLite to PostgreSQL migration.
- Container images on GHCR for `linux/amd64` and `linux/arm64` for each
  release tag, with an SBOM and build provenance.
- GitHub releases with generated notes for each `vX.Y.Z` tag.
- The user guide is published from this repository at
  <https://kamilrybacki.github.io/splice-dock/>.

### Changed

- `better-sqlite3` upgraded to 13, which ships prebuilt binaries for current
  Node.js versions. npm still starts a `node-gyp` build for it
  ([npm/cli#9837](https://github.com/npm/cli/issues/9837)); the image skips
  it, and on a machine without Python and a C++ compiler
  `npm install -g splicedock --ignore-scripts` works.
- CI runs only on GitHub-hosted runners.

### Removed

- **Breaking:** compatibility with the former project name. The gateway no
  longer reads `CELLARETTE_*` environment variables and no longer accepts the
  `X-Cellarette-CSRF` or `X-Cellarette-Authelia` headers. Use `SPLICEDOCK_*`,
  `X-Splicedock-CSRF` and `X-Splicedock-Authelia`.

[Unreleased]: https://github.com/kamilrybacki/splice-dock/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kamilrybacki/splice-dock/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kamilrybacki/splice-dock/releases/tag/v1.0.0
