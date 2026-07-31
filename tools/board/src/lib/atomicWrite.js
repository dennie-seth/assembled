import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);

  await fs.writeFile(tmpPath, content, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}
