/**
 * Static registry of external capabilities/resources actually confirmed available to the
 * runner -- ComfyUI checkpoints/LoRAs, ComfyUI node classes known to exist here, and reachable
 * service endpoints. Checked by capabilityPreflight.js against what a card's Acceptance section
 * names, before an implementer is spawned (HANDOFF §23-b).
 *
 * This is a snapshot of what the setup docs (and prior successful generations) confirmed exists,
 * not a live probe -- a live HTTP call to ComfyUI from inside a preflight check would make the
 * runner's pick-up loop depend on GPU-box uptime for every card, including ones that never touch
 * assets. A model/node genuinely installed after this file was last updated must be added here
 * (with its source cited, same as every other entry) before an AC that names it will pass.
 */

// docs/comfyui-setup.md (T-0070): sd_xl_base_1.0.safetensors, checkpoints/ dir.
// ASSET_PROVENANCE.md (T-0072 LoRA training run): soviet_brutalism_style_v1.safetensors.
export const INSTALLED_MODELS = Object.freeze(["sd_xl_base_1.0.safetensors", "soviet_brutalism_style_v1.safetensors"]);

// ComfyUI built-in node classes actually exercised by a committed workflow in this repo, or
// confirmed present per docs/comfyui-setup.md's test-generation graph -- not an exhaustive list
// of everything ComfyUI ships. T-0221's failure (a provenance record named `SolidMask` +
// `JoinImageWithAlpha`, neither of which was ever confirmed to exist) is exactly the class of
// gap this list exists to catch; it deliberately does not include either.
export const INSTALLED_COMFYUI_NODES = Object.freeze([
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "EmptyLatentImage",
  "KSampler",
  "VAEDecode",
  "SaveImage",
  "LoraLoader",
  // MEMORY.md (T-0214): confirmed present on the dev host's ComfyUI, though it quantizes to
  // colors sampled from the image itself, not a fixed palette -- a capability caveat, not an
  // installation gap, so it stays listed as installed.
  "ImageQuantize"
]);

// Reachable base URLs (host:port) -- docs/comfyui-setup.md, docs/HANDOFF.md's firewall-rule
// section, docs/ace-step-setup.md, docs/stable-audio-setup.md. Board API per CLAUDE.md's
// "all local tools bind 127.0.0.1 only" rule.
export const REACHABLE_SERVICE_ENDPOINTS = Object.freeze([
  "127.0.0.1:8188", // ComfyUI, Windows-host-local (docs/comfyui-setup.md)
  "172.18.192.1:8188", // ComfyUI from WSL, once docs/HANDOFF.md's firewall rule is applied
  "127.0.0.1:8001", // ACE-Step (docs/ace-step-setup.md)
  "127.0.0.1:8002", // Stable Audio Open (docs/stable-audio-setup.md)
  "127.0.0.1:4173" // board API (CLAUDE.md: local tools bind 127.0.0.1 only)
]);
