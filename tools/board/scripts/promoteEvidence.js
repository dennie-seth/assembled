#!/usr/bin/env node
/**
 * Promotes an asset-run round's decisive frames -- the ones its own attempt log cites -- out of
 * gitignored `assets/out/` scratch and into a tracked `docs/assets/evidence/<CARD>/` path, so they
 * survive the worktree that produced them being reaped and show up in the PR diff for review
 * (T-0314; see docs/assets/evidence-promotion.md for the full rationale and the citation
 * convention it documents).
 *
 * This is the intended fix for "an agent forgot to copy the frames by hand": run this one command
 * at the end of every round, promotion or finding alike, instead of manually `cp`-ing files you
 * have to remember to pick. As of T-0314 nothing invokes this automatically yet -- see
 * docs/assets/evidence-promotion.md's "citation convention" section for the still-open
 * `.claude/rules/assets.md` / agent-grant wiring this needs.
 *
 * usage: node tools/board/scripts/promoteEvidence.js <cardId> <runDir> <logPath>
 *          [--evidence-root <path>] [--max-files <n>] [--max-file-bytes <n>] [--repo-root <path>]
 *
 * Prints a single JSON summary to stdout. Exit codes: 0 on any completed run (including "nothing
 * to promote" -- a crashed/empty run must not fail the card), 64 on bad usage.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteEvidence } from "../src/lib/evidencePromotion.js";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = [
  "usage: node tools/board/scripts/promoteEvidence.js <cardId> <runDir> <logPath>",
  "         [--evidence-root <path>] [--max-files <n>] [--max-file-bytes <n>] [--repo-root <path>]"
].join("\n");

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--evidence-root") options.evidenceRoot = argv[++i];
    else if (arg === "--max-files") options.maxFiles = Number(argv[++i]);
    else if (arg === "--max-file-bytes") options.maxFileBytes = Number(argv[++i]);
    else if (arg === "--repo-root") options.repoRoot = argv[++i];
    else positional.push(arg);
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [cardId, runDir, logPath] = positional;
  if (!cardId || !runDir || !logPath) {
    console.error(`promoteEvidence: missing arguments\n${USAGE}`);
    process.exitCode = 64;
    return;
  }

  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const result = await promoteEvidence({
    repoRoot,
    cardId,
    runDir: path.resolve(repoRoot, runDir),
    logPath: path.resolve(repoRoot, logPath),
    ...(options.evidenceRoot ? { evidenceRoot: options.evidenceRoot } : {}),
    ...(Number.isFinite(options.maxFiles) ? { maxFiles: options.maxFiles } : {}),
    ...(Number.isFinite(options.maxFileBytes) ? { maxFileBytes: options.maxFileBytes } : {})
  });

  console.log(
    JSON.stringify({
      cardId,
      evidenceDir: path.relative(repoRoot, result.evidenceDir),
      promoted: result.promoted.map((p) => ({ cited: p.cited, destRelPath: p.destRelPath, bytes: p.bytes })),
      skippedMissing: result.skippedMissing,
      skippedTooLarge: result.skippedTooLarge,
      skippedOverCap: result.skippedOverCap,
      unchanged: result.unchanged
    })
  );
}

main().catch((err) => {
  console.error(`promoteEvidence: ${err.message}`);
  process.exitCode = 1;
});
