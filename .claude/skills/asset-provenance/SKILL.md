---
name: asset-provenance
description: Appends a model+license+prompt+seed entry to ASSET_PROVENANCE.md for a curated generated asset, and refuses if the checkpoint isn't on the approved license allowlist.
---

# asset-provenance

Used by the `assets` and `audio` agents for every curated asset that lands
under `assets/final/`. Mandatory, non-optional — see
`.claude/rules/conduct.md` and `.claude/rules/assets.md`.

## Steps

1. **Check the license allowlist first.** The checkpoint/model used to
   generate the asset must be Apache-2.0, OpenRAIL, or CC0(-derived).
   **No CC-BY-NC** (MusicGen, AudioGen, and any other NC-licensed model are
   excluded outright).
2. **If the checkpoint is not on the allowlist, refuse.** Do not generate
   the asset, do not write a provenance entry for it, and do not curate it
   into `assets/final/`. Report back which model was requested and why it's
   excluded (this is the hook `assets.md` describes — this skill is where
   it's enforced in practice for anything not already gated at the HTTP
   layer).
3. **If allowed, append an entry to `ASSET_PROVENANCE.md`** at the repo
   root, one entry per generated asset:
   ```
   ## assets/final/<path>
   - model: <checkpoint name + version>
   - license: <Apache-2.0 | OpenRAIL | CC0>
   - prompt: <full prompt used>
   - seed: <seed value>
   - generated: <YYYY-MM-DD>
   ```
4. Confirm the entry was written before the card leaves `in-progress` — a
   curated asset with no provenance entry is not done, regardless of how it
   looks.
