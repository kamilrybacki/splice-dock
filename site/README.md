# Splicedock user documentation

Edit the public guide in `site/`. Build and validate it from the repository root:

```sh
npm run docs:build
npm run docs:check
```

The build writes public pages, examples, assets, and a search index to `_site/`.
The validator checks page language, links, anchors, assets, and private infrastructure patterns.
Keep the existing page slugs and anchors so shared links continue to work.

GitHub Pages is published through the `kamilrybacki/kamilrybacki.github.io` repository.
After merging a guide change, copy the generated site to `public/splicedock/` there
and open a PR. Eleventy publishes that directory at `/splicedock/`.
