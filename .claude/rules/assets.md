---
paths: ["assets/**"]
---

# Asset conventions

- **License allowlist, enforced by a hook, not a convention:** generated
  assets only from Apache-2.0 / OpenRAIL / CC0-derived models. The asset
  agent must refuse to run a workflow whose checkpoint isn't on the
  approved-license list.
- **No CC-BY-NC weights** (MusicGen, AudioGen, or any NC-licensed model).
  This repo is public; NC would poison every fork.
- `ASSET_PROVENANCE.md` is mandatory, non-optional, written by the asset
  agent for every generated asset: `model + license + prompt + seed`.
- `assets/out/` is gitignored — generation is reproducible from
  `assets/src/` (workflow JSON + prompt + seed + model hash). Only curated
  finals under `assets/final/` are committed.
- `art/*` branches are strictly additive (new files only) and each covers
  one coherent asset set, merged whole. See `docs/branching.md`.
- Image Git LFS patterns are deferred to the art-direction decision — do
  not commit image binaries until `.gitattributes` is updated accordingly.
