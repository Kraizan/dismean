/** Stream on-disk CSV for HTTP download. See docs/code-map.md · LLD §10. */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";

export async function streamCsvFile(
  absolutePath: string,
  res: Response,
): Promise<void> {
  await access(absolutePath);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  await pipeline(createReadStream(absolutePath), res);
}
