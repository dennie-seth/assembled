import { describe, it, expect } from "vitest";
import {
  INSTALLED_MODELS,
  INSTALLED_COMFYUI_NODES,
  REACHABLE_SERVICE_ENDPOINTS
} from "../../src/runner/capabilityInventory.js";

describe("capabilityInventory", () => {
  it("lists the ComfyUI checkpoint and LoRA confirmed installed per docs/comfyui-setup.md and ASSET_PROVENANCE.md", () => {
    expect(INSTALLED_MODELS).toContain("sd_xl_base_1.0.safetensors");
    expect(INSTALLED_MODELS).toContain("soviet_brutalism_style_v1.safetensors");
  });

  it("lists the player-identity LoRA T-0237 trained and left on disk", () => {
    // assets/final/lora/player_identity_v1.safetensors exists (T-0237, PR #258) but was never
    // added here, so any card naming it as a genuine prerequisite would have falsely blocked.
    expect(INSTALLED_MODELS).toContain("player_identity_v1.safetensors");
  });

  it("lists the SAM3.1 checkpoint installed on the host for T-0337's cutout work", () => {
    // Installed 2026-09-28 into F:\ComfyUI\models\diffusion_models\ (the folder UNETLoader reads).
    // Its absence here blocked T-0337's fix round at capabilityPreflight even though the weights
    // were genuinely present -- the same false block this inventory's own header warns about.
    expect(INSTALLED_MODELS).toContain("sam3.1_multiplex_fp16.safetensors");
  });

  it("lists every other model verified present in the host's ComfyUI model folders", () => {
    // Enumerated from F:\ComfyUI\models\{loras,controlnet,ipadapter,clip_vision} on 2026-09-28.
    // Each was on disk long before this commit; none had ever been added, so an AC naming any of
    // them would have falsely blocked exactly as sam3.1 did.
    for (const name of [
      "player_identity_profile_v1.safetensors",
      "player_identity_v2.safetensors",
      "player_identity_v2_checkpoint_demo.safetensors",
      "smoke_test_T0248.safetensors",
      "controlnet-openpose-sdxl-1.0_xinsir.safetensors",
      "ip-adapter-plus_sdxl_vit-h.safetensors",
      "ip-adapter_sdxl.safetensors",
      "ip-adapter_sdxl_vit-h.safetensors",
      "CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors",
      "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
    ]) {
      expect(INSTALLED_MODELS).toContain(name);
    }
  });

  it("still excludes a model that is not on the host, so the guard keeps its teeth", () => {
    // The inventory is an allowlist, not a wildcard: capabilityPreflight must still refuse an AC
    // naming something nobody installed (T-0221's SolidMask precedent, model-side).
    expect(INSTALLED_MODELS).not.toContain("sam3_not_installed.safetensors");
    expect(INSTALLED_MODELS).not.toContain("sd_xl_refiner_1.0.safetensors");
  });

  it("lists only ComfyUI node classes actually confirmed reachable here, not an exhaustive built-in catalog", () => {
    expect(INSTALLED_COMFYUI_NODES).toContain("CheckpointLoaderSimple");
    expect(INSTALLED_COMFYUI_NODES).toContain("ImageQuantize");
    // T-0221 precedent: this node was named in a provenance record but never confirmed to exist
    // anywhere in the repo -- exactly the gap this inventory exists to catch, so it must stay absent.
    expect(INSTALLED_COMFYUI_NODES).not.toContain("SolidMask");
  });

  it("lists reachable service endpoints as host:port, matching docs/comfyui-setup.md, docs/HANDOFF.md, docs/ace-step-setup.md, docs/stable-audio-setup.md, and CLAUDE.md's 127.0.0.1-only rule", () => {
    expect(REACHABLE_SERVICE_ENDPOINTS).toContain("127.0.0.1:8188");
    expect(REACHABLE_SERVICE_ENDPOINTS).toContain("172.18.192.1:8188");
    expect(REACHABLE_SERVICE_ENDPOINTS).toContain("127.0.0.1:4173");
  });

  it("freezes every list so a preflight run can never mutate the shared inventory", () => {
    expect(Object.isFrozen(INSTALLED_MODELS)).toBe(true);
    expect(Object.isFrozen(INSTALLED_COMFYUI_NODES)).toBe(true);
    expect(Object.isFrozen(REACHABLE_SERVICE_ENDPOINTS)).toBe(true);
  });
});
