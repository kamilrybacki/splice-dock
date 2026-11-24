# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/kamilrybacki/splice-dock/releases/tag/v1.0.0
