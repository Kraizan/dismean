import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";

function parseHeaderDict(headerStr: string): { descr: string; fortran: boolean; shape: number[] } {
  const descrMatch = /'descr':\s*'([^']+)'/.exec(headerStr);
  const fortranMatch = /'fortran_order':\s*(True|False)/.exec(headerStr);
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(headerStr);
  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error("Invalid .npy header dict");
  }
  const descr = descrMatch[1]!;
  const fortran = fortranMatch[1] === "True";
  const shapeParts = shapeMatch[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const shape = shapeParts.map((p) => Number(p));
  if (shape.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("Invalid .npy shape");
  }
  return { descr, fortran, shape };
}

/**
 * Minimal NumPy .npy v1.0 / v2.0 1D uint8 array parser.
 * Avoids writing duplicate CSV files on disk during generation.
 */
export function parseUint8Npy(buf: Buffer): Uint8Array {
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
  const headerStr = buf.subarray(10, offset).toString("ascii");
  const { descr, fortran, shape } = parseHeaderDict(headerStr);
  if (descr !== "|u1" && descr !== "<u1" && descr !== "uint8") {
    throw new Error(`Expected uint8 .npy, got descr ${descr}`);
  }
  if (fortran) {
    throw new Error("Fortran-order .npy not supported");
  }
  if (shape.length !== 1) {
    throw new Error("Only 1-D .npy arrays are supported");
  }
  const n = shape[0]!;
  const data = new Uint8Array(buf.buffer, buf.byteOffset + offset, buf.length - offset);
  if (data.length < n) {
    throw new Error("Truncated .npy payload");
  }
  return data.subarray(0, n);
}

export async function streamNpyFile(absolutePath: string, res: Response): Promise<void> {
  await pipeline(createReadStream(absolutePath), res);
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
