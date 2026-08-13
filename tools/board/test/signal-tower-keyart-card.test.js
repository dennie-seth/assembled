/**
 * T-0155: Card of record for Signal Tower key art.
 *
 * Asserts:
 *   1. tasks/T-0155.md exists and parses as a valid board card.
 *   2. All 7 expected assets are present in assets/src/keyart/.
 *   3. Provenance sidecars in assets/src/keyart/ carry no `concept_hash`
 *      field — key art must not appear to be a conditioning input for
 *      T-0106's coherence guard (13-asset-pipeline.md §6.8).
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTask } from "../src/lib/taskParser.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const CARD_PATH = path.join(REPO_ROOT, "tasks", "T-0155.md");
const KEYART_DIR = path.join(REPO_ROOT, "assets", "src", "keyart");

const EXPECTED_ASSETS = [
  "README.md",
  "signal_tower_exterior.png",
  "signal_tower_exterior.recipe.json",
  "signal_tower_exterior.provenance.json",
  "signal_tower_interior.png",
  "signal_tower_interior.recipe.json",
  "signal_tower_interior.provenance.json",
];

describe("T-0155 — Signal Tower key art card of record", () => {
  it("tasks/T-0155.md exists", () => {
    expect(fs.existsSync(CARD_PATH), "tasks/T-0155.md must exist").toBe(true);
  });

  it("tasks/T-0155.md parses as a valid card with required fields", () => {
    const raw = fs.readFileSync(CARD_PATH, "utf8");
    const task = parseTask(raw);
    expect(task.id).toBe("T-0155");
    expect(task.status).toMatch(/^(backlog|ready|in-progress|validation|review|done|blocked)$/);
    expect(task.priority).toMatch(/^P[0-3]$/);
    expect(typeof task.phase).toBe("number");
    expect(task.body).toMatch(/## Context/);
    expect(task.body).toMatch(/## Acceptance/);
  });

  it("all 7 Signal Tower key art assets are present in assets/src/keyart/", () => {
    const present = fs.readdirSync(KEYART_DIR);
    for (const asset of EXPECTED_ASSETS) {
      expect(present, `${asset} must be in assets/src/keyart/`).toContain(asset);
    }
    expect(present).toHaveLength(EXPECTED_ASSETS.length);
  });

  it("provenance sidecars in assets/src/keyart/ have no concept_hash field", () => {
    const provenanceFiles = fs
      .readdirSync(KEYART_DIR)
      .filter((f) => f.endsWith(".provenance.json"));
    expect(provenanceFiles.length).toBeGreaterThan(0);
    for (const file of provenanceFiles) {
      const data = JSON.parse(
        fs.readFileSync(path.join(KEYART_DIR, file), "utf8")
      );
      expect(
        Object.prototype.hasOwnProperty.call(data, "concept_hash"),
        `${file} must not have a concept_hash field (key art is not a conditioning input per 13-asset-pipeline.md §6.8)`
      ).toBe(false);
    }
  });
});
