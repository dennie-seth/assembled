#!/usr/bin/env node
import { countCommittedAssets } from "../src/lib/committedAssetCount.js";

function parseArgs(argv) {
  const cardId = argv[0];
  let repoRoot = process.cwd();
  let ref = "HEAD";

  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--repo-root") {
      repoRoot = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--ref") {
      ref = argv[i + 1];
      i += 1;
    }
  }

  return { cardId, repoRoot, ref };
}

async function main() {
  const { cardId, repoRoot, ref } = parseArgs(process.argv.slice(2));

  if (!cardId || cardId.startsWith("--")) {
    console.error(
      "Usage: node countCommittedAssets.js <T-NNNN> [--repo-root <path>] [--ref <ref>]"
    );
    process.exitCode = 1;
    return;
  }

  const result = await countCommittedAssets({ repoRoot, ref, cardId });
  console.log(JSON.stringify({ cardId, ref, count: result.count, files: result.files }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
