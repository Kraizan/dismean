import { describe, expect, it } from "vitest";
import { parseUint8Npy } from "../src/storage/npy.js";

function makeNpyV1(values: number[]): Buffer {
  const headerObj = `{'descr': '|u1', 'fortran_order': False, 'shape': (${values.length},), }`;
  const baseLen = 10 + headerObj.length + 1;
  const padLen = (64 - (baseLen % 64)) % 64;
  const headerStr = headerObj + " ".repeat(padLen) + "\n";
  const headerBuf = Buffer.from(headerStr, "ascii");
  const prefix = Buffer.alloc(10);
  prefix[0] = 0x93;
  prefix.write("NUMPY", 1, "ascii");
  prefix[6] = 1;
  prefix[7] = 0;
  prefix.writeUInt16LE(headerBuf.length, 8);
  return Buffer.concat([prefix, headerBuf, Buffer.from(values)]);
}

describe("parseUint8Npy", () => {
  it("parses valid uint8 .npy v1.0 buffers", () => {
    const buf = makeNpyV1([0, 42, 100, 7]);
    const arr = parseUint8Npy(buf);
    expect([...arr]).toEqual([0, 42, 100, 7]);
  });

  it("rejects non-npy buffers", () => {
    expect(() => parseUint8Npy(Buffer.from("not-npy"))).toThrow();
  });

  it("rejects non-uint8 descr", () => {
    const headerObj = `{'descr': '<i8', 'fortran_order': False, 'shape': (2,), }`;
    const baseLen = 10 + headerObj.length + 1;
    const padLen = (64 - (baseLen % 64)) % 64;
    const headerStr = headerObj + " ".repeat(padLen) + "\n";
    const headerBuf = Buffer.from(headerStr, "ascii");
    const prefix = Buffer.alloc(10);
    prefix[0] = 0x93;
    prefix.write("NUMPY", 1, "ascii");
    prefix[6] = 1;
    prefix[7] = 0;
    prefix.writeUInt16LE(headerBuf.length, 8);
    const buf = Buffer.concat([prefix, headerBuf, Buffer.from([0, 0])]);
    expect(() => parseUint8Npy(buf)).toThrow(/uint8/);
  });
});
