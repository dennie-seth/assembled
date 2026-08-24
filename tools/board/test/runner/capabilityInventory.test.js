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
