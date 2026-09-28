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
// ASSET_PROVENANCE.md (T-0237 Arm B stage-1 training run, PR #258):
// player_identity_v1.safetensors, committed at assets/final/lora/ and present on the GPU host.
// It was trained and left on disk but never listed here, so any card naming it as a genuine
// prerequisite would have falsely blocked -- the mirror image of the T-0248 false positive.
//
// 2026-09-28 reconciliation: every entry below this line was verified present on the host by
// enumerating F:\ComfyUI\models\{diffusion_models,checkpoints,loras,controlnet,ipadapter,
// clip_vision} directly -- nothing is listed on the strength of a doc or a card claim alone.
// The trigger was T-0337's FIX ROUND 1 being refused by capabilityPreflight for naming a
// checkpoint that was genuinely installed; ten further models turned out to be in the same
// state (on disk, never listed), so any AC naming one would have blocked just as falsely.
export const INSTALLED_MODELS = Object.freeze([
  "sd_xl_base_1.0.safetensors",
  "soviet_brutalism_style_v1.safetensors",
  "player_identity_v1.safetensors",

  // models/diffusion_models/ -- the folder the generic UNETLoader (nodes.py:966-989) reads.
  // Comfy-Org/sam3.1 (commit 7bb83747, not gated), 1,745,546,848 bytes,
  // sha256 9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03. Classified SAM31 by
  // comfy/model_detection.py:1060-1066 (all three gate keys present in the state dict), and
  // /object_info/UNETLoader lists it in unet_name -- that list was empty before this file landed.
  "sam3.1_multiplex_fp16.safetensors",

  // models/loras/ -- present on disk alongside player_identity_v1 above.
  "player_identity_profile_v1.safetensors",
  "player_identity_v2.safetensors",
  // Training/demo artifacts, listed because the guard's question is "does this file exist", not
  // "should a card prefer it" -- an AC naming one must not be blocked as a phantom.
  "player_identity_v2_checkpoint_demo.safetensors",
  "smoke_test_T0248.safetensors",

  // models/controlnet/ -- the OpenPose ControlNet the forward-limb work (T-0380/T-0387/T-0394)
  // has been driving through ControlNetApplyAdvanced all along.
  "controlnet-openpose-sdxl-1.0_xinsir.safetensors",

  // models/ipadapter/ -- the IP-Adapter set the master-sheet recipe (T-0336/T-0351) uses.
  "ip-adapter-plus_sdxl_vit-h.safetensors",
  "ip-adapter_sdxl.safetensors",
  "ip-adapter_sdxl_vit-h.safetensors",

  // models/clip_vision/ -- the vision encoders those IP-Adapters load against.
  "CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors",
  "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
]);

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
