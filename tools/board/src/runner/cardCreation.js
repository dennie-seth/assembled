import path from "node:path";
import { commitTaskFile, autoCommitCardsOnCreateFromEnv } from "./gitOps.js";

const FIELD_DEFAULTS = {
  status: "backlog",
  priority: "P2",
  agent: null,
  depends_on: [],
  body: ""
};

/**
 * Creates a card through the same three primitives `httpApi.js`'s `handleCreateTask` uses, in
 * the same order -- `idAllocator.allocate()` -> `store.create()` -> (if enabled)
 * `commitTaskFile()`, with the same "a commit failure must never fail card creation" behavior.
 * Not a refactor of the HTTP handler itself (see docs/design/flow-stats-self-improvement.md for
 * why); this is the shared non-HTTP core both that handler and the flow-stats self-improvement
 * loop call through.
 */
export async function createCard({ store, idAllocator, repoRoot, tasksDir, fields, logger = console }) {
  const id = await idAllocator.allocate();
  const task = {
    id,
    title: fields.title,
    status: fields.status ?? FIELD_DEFAULTS.status,
    priority: fields.priority ?? FIELD_DEFAULTS.priority,
    phase: fields.phase,
    agent: fields.agent === undefined ? FIELD_DEFAULTS.agent : fields.agent,
    depends_on: fields.depends_on ?? FIELD_DEFAULTS.depends_on,
    created: fields.created ?? new Date().toISOString().slice(0, 10),
    body: fields.body ?? FIELD_DEFAULTS.body,
    ...(fields.deliverable_type !== undefined ? { deliverable_type: fields.deliverable_type } : {})
  };

  const created = await store.create(task);

  if (repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const relativePath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      await commitTaskFile({ repoRoot, filePath: relativePath, message: `chore(board): add card ${id}` });
    } catch (err) {
      // Matches handleCreateTask's rationale exactly: card creation must never fail because git
      // couldn't commit it.
      logger.warn(`Board: failed to commit card file for ${id} (leaving it untracked):`, err.message);
    }
  }

  return created;
}
