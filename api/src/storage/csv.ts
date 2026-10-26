import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";

export async function streamCsvFile(
  absolutePath: string,
  res: Response,
): Promise<void> {
  res.setHeader("Content-Type", "text/csv");
  await pipeline(createReadStream(absolutePath), res);
}
