/** Uint8 `.npy` parse and CSV streaming for downloads. See docs/code-map.md · LLD §10. */
import { readFile } from "node:fs/promises";
import type { Response } from "express";

/** Minimal NumPy .npy v1.0 / v2.0 1D uint8 array parser. */
export function parseUint8Npy(buf: Buffer): Uint8Array {
  // Magic: \x93NUMPY
  if (
    buf.length < 10 ||
    buf[0] !== 0x93 ||
    buf.subarray(1, 6).toString("ascii") !== "NUMPY"
  ) {
    throw new Error("Invalid .npy file header");
  }
  const major = buf[6]!;
  let headerLen: number;
  let offset: number;
  if (major === 1) {
    headerLen = buf.readUInt16LE(8);
    offset = 10 + headerLen;
  } else if (major === 2 || major === 3) {
    headerLen = buf.readUInt32LE(8);
    offset = 12 + headerLen;
  } else {
    throw new Error(`Unsupported .npy version ${major}`);
  }
  if (offset > buf.length) {
    throw new Error("Truncated .npy header");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset + offset, buf.length - offset);
}

export async function streamNpyAsCsv(
  absolutePath: string,
  res: Response,
): Promise<void> {
  const buf = await readFile(absolutePath);
  const arr = parseUint8Npy(buf);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");

  const CHUNK = 16_384;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, arr.length);
    const parts: string[] = [];
    for (let j = i; j < end; j++) {
      parts.push(String(arr[j]!));
    }
    const prefix = i === 0 ? "" : ",";
    const suffix = end === arr.length ? "\n" : "";
    const ok = res.write(prefix + parts.join(",") + suffix);
    if (!ok) {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  }
  if (arr.length === 0) {
    res.write("\n");
  }
  res.end();
}
