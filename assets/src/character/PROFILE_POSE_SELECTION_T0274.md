# Profile-pose LoRA selection — T-0274

**Author:** Claude (Sonnet 5)

## Decision

**Train a separate, additive `player_identity_profile_v1` LoRA on
[T-0273](T-0273)'s committed, direction-approved profile reference set**,
per the locked **per-pose, per-character/monster LoRA** decision
(@DennieSeth, Pipeline chat, 2026-08-31). `player_identity_v2` — the
single-canonical-costume **front-facing** identity LoRA every committed
§24-e asset depends on — is not touched, retrained, or regressed by this
card.

## Why a separate LoRA, not a retrain of `player_identity_v2`

[T-0272](T-0272) ran four full §24-e generations against a purpose-built
profile-topology OpenPose skeleton (`pose_rig_profile_T0272.py`, on branch
`feature/T-0272`) with `player_identity_v2` supplying identity. All four
attempts rendered front-facing or otherwise not-a-profile output — the
skeleton is a genuinely different topology, but `player_identity_v2` was
trained exclusively on front-facing material and has never seen the
character in profile, so it cannot place one. That finding is what this
card exists to answer: a **profile-specific LoRA trained on real profile
references** is the per-pose fix, distinct from (and additive to) the
existing front-facing identity LoRA.

## Why the training set is anonymous pose reference, not costume material

T-0273's approved set (`player_profile_reference_SUMMARY.md`) is
**explicitly not a costume match** — three Muybridge "Animal Locomotion"
photographic plates (public domain, 1887) and three flat black-silhouette
illustrations (CC0), none depicting the player's institutional-green-coat
costume. That is by design, not a gap: T-0209's concept sheet remains the
sole identity/costume authority, and no true side-on photograph of the
game's own character exists to train on. This LoRA's job is narrower than
`player_identity_v2`'s — it teaches the **side-on pose** (leg fore-aft
placement, arm asymmetry, head turned) as a learnable concept, under its
own trigger token (`sbrutalistprofilepose`, distinct from
`player_identity_v2`'s `sbrutalistplayer`), meant to be **stacked** with
`player_identity_v2` at generation time so identity/costume comes from one
LoRA and profile-pose capability from the other.

## Preprocessing

Unlike `player_identity_v2`'s IP-Adapter-generated 1024x1024 training views,
T-0273's sources are real photographs/illustrations of varying aspect ratio
(1536x929 Muybridge plates, 600x900 silhouette portraits). sd-scripts'
non-bucketed dataset path (the same one every prior identity LoRA training
run in this repo uses) requires square input, so
`char_gen.prepare_profile_refs.letterbox_to_square` scales each source to
fit and pads to a square canvas — never crops (would cut real gait content
off a photographic plate) and never stretches (would distort the pose this
LoRA exists to teach).

## Training recipe

Same rank/alpha/learning-rate/optimizer as `player_identity_v2`
(`training_config_player_identity_v2.toml`) — only the training set and
trigger token change, isolating that one variable. See
`training_config_player_identity_profile_v1.toml` for the full spec.
