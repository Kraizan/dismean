import { rm } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { jobDirRelative } from "../paths.js";

export async function deleteJobDir(
  config: Config,
  jobId: string,
): Promise<void> {
  const dir = path.join(config.DATA_DIR, jobDirRelative(jobId));
  await rm(dir, { recursive: true, force: true });
}
