// Diagnostic: walk the inflated index pickle opcode by opcode.
import { openSync, readSync, closeSync } from "node:fs";
import { inflateSync } from "node:zlib";

const p = process.argv[2];
const fd = openSync(p, "r");
const hb = Buffer.alloc(64);
readSync(fd, hb, 0, 64, 0);
const nl = hb.indexOf(0x0a);
const parts = hb.toString("latin1", 0, nl).split(/\s+/);
const off = parseInt(parts[1], 16);
const big = Buffer.alloc(1 << 21);
const n = readSync(fd, big, 0, 1 << 21, off);
closeSync(fd);
const buf = inflateSync(big.subarray(0, n));
console.log(`inflated ${buf.length} bytes from offset ${off}\n`);

const NAMES = {
  0x28: "MARK", 0x2e: "STOP", 0x30: "POP", 0x31: "POP_MARK", 0x32: "DUP",
  0x46: "FLOAT", 0x47: "BINFLOAT", 0x49: "INT", 0x4a: "BININT", 0x4b: "BININT1",
  0x4c: "LONG", 0x4d: "BININT2", 0x4e: "NONE", 0x50: "PERSID", 0x51: "BINPERSID",
  0x52: "REDUCE", 0x53: "STRING", 0x54: "BINSTRING", 0x55: "SHORT_BINSTRING",
  0x56: "UNICODE", 0x58: "BINUNICODE", 0x5a: "NONE?", 0x61: "APPEND", 0x62: "BUILD",
  0x63: "GLOBAL", 0x64: "DICT", 0x65: "APPENDS", 0x67: "GET", 0x68: "BINGET",
  0x69: "INST", 0x6a: "LONG_BINGET", 0x6c: "LIST", 0x6f: "OBJ", 0x70: "PUT",
  0x71: "BINPUT", 0x72: "LONG_BINPUT", 0x73: "SETITEM", 0x74: "TUPLE",
  0x75: "SETITEMS", 0x80: "PROTO", 0x81: "NEWOBJ", 0x82: "EXT1", 0x83: "EXT2",
  0x84: "EXT4", 0x85: "TUPLE1", 0x86: "TUPLE2", 0x87: "TUPLE3", 0x88: "NEWTRUE",
  0x89: "NEWFALSE", 0x8a: "LONG1", 0x8b: "LONG4", 0x8c: "SHORT_BINUNICODE",
  0x8d: "BINUNICODE8", 0x8e: "BINBYTES8", 0x8f: "EMPTY_SET", 0x90: "ADDITEMS",
  0x91: "FROZENSET", 0x92: "FROZENSET?", 0x93: "STACK_GLOBAL", 0x94: "MEMOIZE",
  0x95: "FRAME", 0x96: "BYTEARRAY8", 0x97: "NEXT_BUFFER", 0x98: "READONLY_BUFFER",
};

let pos = 0;
const u8 = () => buf[pos++];
const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
const i32 = () => { const v = buf.readInt32LE(pos); pos += 4; return v; };
const i64 = () => { const v = buf.readBigInt64LE(pos); pos += 8; return v; };

for (let step = 0; step < 26; step += 1) {
  const start = pos;
  if (pos >= buf.length) { console.log("EOF"); break; }
  const op = u8();
  const name = NAMES[op] ?? `UNKNOWN(0x${op.toString(16)})`;
  let detail = "";
  switch (op) {
    case 0x80: detail = `proto=${u8()}`; break;
    case 0x95: detail = `framelen=${i64()}`; break;
    case 0x8c: { const l = u8(); detail = `len=${l} ${JSON.stringify(buf.subarray(pos, pos + l).toString("utf8"))}`; pos += l; break; }
    case 0x58: { const l = u32(); detail = `len=${l} ${JSON.stringify(buf.subarray(pos, pos + l).toString("utf8"))}`; pos += l; break; }
    case 0x8d: { const l = Number(buf.readBigUInt64LE(pos)); pos += 8; detail = `len=${l}`; break; }
    case 0x4a: detail = `${i32()}`; break;
    case 0x4b: detail = `${u8()}`; break;
    case 0x4d: { const v = buf.readUInt16LE(pos); pos += 2; detail = `${v}`; break; }
    case 0x71: detail = `memo=${u8()}`; break;
    case 0x72: detail = `memo=${u32()}`; break;
    case 0x94: detail = "memo(top)"; break;
    case 0x43: { const l = u8(); detail = `len=${l} bytes`; pos += l; break; }
    case 0x42: { const l = u32(); detail = `len=${l} bytes`; pos += l; break; }
  }
  console.log(`@${String(start).padStart(3)}  ${name.padEnd(18)} ${detail}`);
}
