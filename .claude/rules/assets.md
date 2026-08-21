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
- **Every curated final, concept sheet, or key art file also gets uploaded
  to its card via the attachments API — mandatory, in addition to
  committing it, not instead of.** Committing to the repo makes a file
  reproducible; it does not make it visible on the ticket, and the
  asset-export stager and Drive sync are attachments-only — a file that is
  only ever committed never reaches either one. Immediately after curating
  a final (or generating a concept sheet / key art file), before you commit
  and stop:
  ```
  curl -X POST "http://127.0.0.1:${BOARD_PORT:-4173}/api/tasks/<id>/attachments" \
    -F "file=@assets/final/<...>/<filename>"
  ```
  (substitute the real `<id>` and the path of the file you just curated —
  `assets/src/concept/<...>` or `assets/src/keyart/<...>` for a concept
  sheet or key art file). Do this for every file you'd want a human to be
  able to see on the card without checking out the branch. This was skipped
  on T-0198–T-0200, T-0209–T-0211, and T-0202 — real character sheets,
  concept art, and an ambience bed committed to the repo and never
  attached — and is now also caught mechanically at review time
  (`checkDeliverable.js`, routed by `verifyRouter.js`'s
  `resolveDeliverableRoute` for any diff touching `assets/final/**`,
  `assets/src/concept/**`, or `assets/src/keyart/**`), but that gate is a
  backstop for a missed step, not a substitute for doing it.
- `art/*` branches are strictly additive (new files only) and each covers
  one coherent asset set, merged whole. See `docs/branching.md`.
- Image Git LFS patterns are deferred to the art-direction decision — do
  not commit image binaries until `.gitattributes` is updated accordingly.
