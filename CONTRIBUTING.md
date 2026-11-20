# Contributing

Thanks for your interest in splice-dock.

## Pull requests

Development happens here: fork the repository, branch from `main` and open a
pull request against `main`. Pull requests are reviewed and merged here.

- For anything larger than a small fix, open an issue first so we can agree on
  the approach.
- Run the same checks as CI:
  `npx tsc --noEmit`, `npm run lint`, `npm run lint:layers`, `npm test`, and
  `npm run docs:build && npm run docs:check` when you change the documentation.
- Keep each pull request focused on one change, and add tests for new behaviour.
- By contributing, you agree that your work is licensed under the [MIT License](LICENSE).

## Releases and images

CI builds the container image on every push to `main` and publishes
`ghcr.io/kamilrybacki/splice-dock:latest` and `:<commit sha>`. A release is a
`vX.Y.Z` tag on `main` (matching `version` in `package.json`), which also
publishes `ghcr.io/kamilrybacki/splice-dock:vX.Y.Z` with an SBOM and build
provenance. Images are built for `linux/amd64` and `linux/arm64`. Pin a tag or a digest in production rather than `:latest`.

The same tag publishes the `splicedock` npm package with provenance through npm
trusted publishing (the `npm` job in `.github/workflows/ci.yml`, GitHub
environment `npm`), then creates a GitHub release with generated notes. If the
tag does not match `version` in `package.json`, the test job fails and nothing
is published.
Record user-visible changes in [CHANGELOG.md](CHANGELOG.md) before tagging.

## Security issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md)
and use GitHub's private vulnerability reporting.
