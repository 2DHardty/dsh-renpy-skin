/**
 * Minimal RPA-3.0 reader for Ren'Py archives.
 *
 * A `.rpa` is a one-line ASCII header, a pickle-encoded index, then the raw
 * file blobs:
 *
 *     RPA-3.0 <hex index offset> <hex key>\n
 *
 * The index is a Python `dict[str, tuple[int, int, bytes]]` mapping each
 * archived name to `(offset, length, prefix)`; the real byte offset of an
 * entry is `offset ^ key`, and its bytes are `prefix + raw[limit]`. Ren'Py
 * writes that pickle with protocol 2, so a small opcode VM is required —
 * regex-scanning the bytes for tuples is not reliable on real archives.
 *
 * Only reading is implemented (this plugin never repacks), and the index is
 * read lazily per call so a big archive costs one header + index parse.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Pickle opcodes we must honour for an index that is a dict of tuples.
 *
 * These are Python's documented opcode values — do not "tidy" them: several of
 * the empty-collection opcodes look like they should sit next to their
 * non-empty counterparts and do not. `EMPTY_DICT` is 0x7d, not 0x64 (`DICT`
 * *is* 0x64 and expects a MARK); an empty tuple is 0x29, not 0x74; and
 * `EMPTY_SET`/`FROZENSET` are 0x8f/0x91. Getting these wrong is invisible on a
 * hand-written fixture and fatal on a real archive: a real Ren'Py index begins
 * `PROTO 5 FRAME ... EMPTY_DICT MEMOIZE ...` and a table that maps 0x7d to
 * nothing fails with "unsupported pickle opcode 0x7d" on the first byte of the
 * dict.
 */
const OP = {
  MARK: 0x28,
  EMPTY_TUPLE: 0x29,
  STOP: 0x2e,
  POP: 0x30,
  POP_MARK: 0x31,
  DUP: 0x32,
  FLOAT: 0x46,
  BINFLOAT: 0x47,
  INT: 0x49,
  BININT: 0x4a,
  BININT1: 0x4b,
  LONG: 0x4c,
  BININT2: 0x4d,
  NONE: 0x4e,
  PERSID: 0x50,
  BINPERSID: 0x51,
  REDUCE: 0x52,
  STRING: 0x53,
  BINSTRING: 0x54,
  SHORT_BINSTRING: 0x55,
  UNICODE: 0x56,
  BINUNICODE: 0x58,
  APPEND: 0x61,
  BUILD: 0x62,
  GLOBAL: 0x63,
  DICT: 0x64,
  APPENDS: 0x65,
  GET: 0x67,
  BINGET: 0x68,
  INST: 0x69,
  LONG_BINGET: 0x6a,
  LIST: 0x6c,
  OBJ: 0x6f,
  PUT: 0x70,
  BINPUT: 0x71,
  LONG_BINPUT: 0x72,
  SETITEM: 0x73,
  TUPLE: 0x74,
  SETITEMS: 0x75,
  EMPTY_DICT: 0x7d,
  EMPTY_LIST: 0x5d,
  PROTO: 0x80,
  NEWOBJ: 0x81,
  EXT1: 0x82,
  EXT2: 0x83,
  EXT4: 0x84,
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  NEWTRUE: 0x88,
  NEWFALSE: 0x89,
  LONG1: 0x8a,
  LONG4: 0x8b,
  SHORT_BINUNICODE: 0x8c,
  BINUNICODE8: 0x8d,
  BINBYTES8: 0x8e,
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  FROZENSET: 0x91,
  NEWOBJ_EX: 0x92,
  STACK_GLOBAL: 0x93,
  MEMOIZE: 0x94,
  FRAME: 0x95,
  SHORT_BINBYTES: 0x43,
  BINBYTES: 0x42,
  BYTEARRAY8: 0x96,
};

/** Thrown when an archive or an entry cannot be read. */
export class RpaError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpaError";
  }
}

/**
 * Interpret the pickle stream holding an RPA index.
 * @param buffer bytes of the pickle stream.
 * @returns the decoded top-level value.
 */
function unpickle(buffer) {
  let pos = 0;
  const stack = [];
  const memo = new Map();

  const read = (n) => {
    if (pos + n > buffer.length) throw new RpaError("pickle stream truncated");
    const slice = buffer.subarray(pos, pos + n);
    pos += n;
    return slice;
  };
  const u8 = () => read(1)[0];
  const u16 = () => read(2).readUInt16LE(0);
  const i32 = () => read(4).readInt32LE(0);
  const u32 = () => read(4).readUInt32LE(0);
  const f64 = () => read(8).readDoubleBE(0);
  // CPython's unpickler pushes a real marker OBJECT for MARK and pops back to
  // it (`markobject` / `pop_mark`). Recording the stack depth instead looks
  // equivalent but is not: MARK never advances the stack, so once a value is
  // pushed after it — which the index does immediately, with the offset integer
  // — the recorded depth points at the WRONG slot. popToMark then removes the
  // value and leaves the mark behind, so the tuple under construction ends up
  // one object short, APPENDS finds something that is not a list, and every
  // name with more than one candidate silently disappears from the index.
  const MARKER = Symbol("pickle MARK");
  const pushMark = () => {
    stack.push(MARKER);
  };
  const popToMark = () => {
    const at = stack.lastIndexOf(MARKER);
    if (at < 0) throw new RpaError("pickle MARK underflow");
    const items = stack.splice(at + 1);
    stack.length = at;
    return items;
  };
  const pop = () => {
    if (stack.length === 0) throw new RpaError("pickle stack underflow");
    return stack.pop();
  };

  /** LONG1 / LONG4 little-endian two's-complement integer. */
  const decodeLong = (bytes) => {
    if (bytes.length === 0) return 0;
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
    if (bytes[bytes.length - 1] & 0x80) value -= 1n << BigInt(bytes.length * 8);
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  };

  /** Opcodes that only ever appear for objects this plugin never indexes. */
  const ignoreGlobal = () => {
    // GLOBAL/STACK_GLOBAL push a callable marker; the following REDUCE would
    // build an object. RPA indexes contain none, so failing loudly is right.
    throw new RpaError("unsupported pickle opcode: GLOBAL");
  };

  while (pos < buffer.length) {
    const opcode = u8();
    switch (opcode) {
      case OP.PROTO: {
        u8();
        break;
      }
      case OP.FRAME: {
        read(8);
        break;
      }
      case OP.MARK:
        pushMark();
        break;
      case OP.STOP:
        return stack.length > 0 ? stack[stack.length - 1] : undefined;
      case OP.POP:
        pop();
        break;
      case OP.POP_MARK:
        popToMark();
        break;
      case OP.DUP:
        stack.push(stack[stack.length - 1]);
        break;
      case OP.NONE:
        stack.push(null);
        break;
      case OP.NEWTRUE:
        stack.push(true);
        break;
      case OP.NEWFALSE:
        stack.push(false);
        break;
      case OP.INT:
        stack.push(Number.parseInt(read(u8()).toString("latin1"), 10));
        break;
      case OP.BININT:
        stack.push(i32());
        break;
      case OP.BININT1:
        stack.push(u8());
        break;
      case OP.BININT2:
        stack.push(u16());
        break;
      case OP.LONG:
        stack.push(Number.parseInt(read(u8()).toString("latin1").replace(/L$/, ""), 10));
        break;
      case OP.LONG1:
        stack.push(decodeLong(read(u8())));
        break;
      case OP.LONG4: {
        const length = i32();
        if (length < 0) throw new RpaError("invalid LONG4 length");
        stack.push(decodeLong(read(length)));
        break;
      }
      case OP.FLOAT:
        stack.push(Number.parseFloat(read(u8()).toString("latin1")));
        break;
      case OP.BINFLOAT:
        stack.push(f64());
        break;
      case OP.STRING: {
        // Protocol 0 STRING: repr-escaped, newline-terminated.
        const end = buffer.indexOf(0x0a, pos);
        if (end < 0) throw new RpaError("unterminated STRING");
        const raw = buffer.toString("latin1", pos, end);
        pos = end + 1;
        stack.push(raw.replace(/^['"]|['"]$/g, ""));
        break;
      }
      case OP.BINSTRING: {
        const length = i32();
        stack.push(read(length).toString("latin1"));
        break;
      }
      case OP.SHORT_BINSTRING:
        stack.push(read(u8()).toString("latin1"));
        break;
      case OP.UNICODE: {
        const end = buffer.indexOf(0x0a, pos);
        if (end < 0) throw new RpaError("unterminated UNICODE");
        const raw = buffer.toString("latin1", pos, end);
        pos = end + 1;
        stack.push(raw.replace(/^u?['"]|['"]$/g, ""));
        break;
      }
      case OP.BINUNICODE:
        stack.push(read(u32()).toString("utf8"));
        break;
      case OP.BINUNICODE8: {
        const length = read(8).readBigUInt64LE(0);
        stack.push(read(Number(length)).toString("utf8"));
        break;
      }
      case OP.SHORT_BINUNICODE:
        stack.push(read(u8()).toString("utf8"));
        break;
      case OP.SHORT_BINBYTES:
        stack.push(Buffer.from(read(u8())));
        break;
      case OP.BINBYTES:
        stack.push(Buffer.from(read(u32())));
        break;
      case OP.BINBYTES8: {
        const length = read(8).readBigUInt64LE(0);
        stack.push(Buffer.from(read(Number(length))));
        break;
      }
      case OP.BYTEARRAY8: {
        const length = read(8).readBigUInt64LE(0);
        stack.push(Buffer.from(read(Number(length))));
        break;
      }
      case OP.EMPTY_TUPLE:
        stack.push([]);
        break;
      case OP.TUPLE1: {
        const a = pop();
        stack.push([a]);
        break;
      }
      case OP.TUPLE2: {
        const b = pop();
        const a = pop();
        stack.push([a, b]);
        break;
      }
      case OP.TUPLE3: {
        const c = pop();
        const b = pop();
        const a = pop();
        stack.push([a, b, c]);
        break;
      }
      case OP.TUPLE:
        stack.push(popToMark());
        break;
      case OP.EMPTY_LIST:
        stack.push([]);
        break;
      case OP.LIST:
        // CPython: `list(markobject())` — LIST builds a list from the marked
        // items. Returning the raw marked slice happened to look right while
        // the only consumer was TUPLE, but it yields an array where pickle
        // semantics say list.
        stack.push(popToMark());
        break;
      case OP.APPEND:
        // CPython: `stack[-2].append(stack.pop())` — the list is the item BELOW
        // the value being appended, not the top of the stack. Getting this
        // wrong appends each value to itself: the tuples disappear into
        // themselves and every index entry decodes to an empty list.
        stack[stack.length - 2].push(pop());
        break;
      case OP.APPENDS: {
        // CPython: `items = stack.pop_mark(); stack[-1].extend(items)` — the
        // pop happens FIRST, and only then is stack[-1] the list. Writing it as
        // `stack[stack.length - 1].push(...popToMark())` resolves the target
        // BEFORE the pop (JavaScript evaluates the member object first), which
        // aims at the top TUPLE, not the list — every name with more than one
        // candidate then decoded to `[]` while single-candidate names looked
        // perfect. The old `length - 2` form had the same problem: it also
        // resolved before the pop, hitting the first tuple instead.
        const marked = popToMark();
        stack[stack.length - 1].push(...marked);
        break;
      }
      case OP.EMPTY_DICT:
        stack.push(new Map());
        break;
      case OP.DICT: {
        // CPython: `dict(markobject())` over a marked list of alternating
        // keys and values. Pushing the raw slice would yield an array, which
        // the index reader rejects as "index is not a dict".
        const pairs = popToMark();
        const dict = new Map();
        for (let i = 0; i + 1 < pairs.length; i += 2) dict.set(pairs[i], pairs[i + 1]);
        stack.push(dict);
        break;
      }
      case OP.SETITEM: {
        const value = pop();
        const key = pop();
        stack[stack.length - 1].set(key, value);
        break;
      }
      case OP.SETITEMS: {
        const items = popToMark();
        const target = stack[stack.length - 1];
        for (let i = 0; i + 1 < items.length; i += 2) target.set(items[i], items[i + 1]);
        break;
      }
      case OP.EMPTY_SET:
        stack.push(new Set());
        break;
      case OP.ADDITEMS: {
        // Same shape as APPEND: the set is below the marked items.
        const items = popToMark();
        const target = stack[stack.length - 1];
        for (const item of items) target.add(item);
        break;
      }
      case OP.BUILD:
        pop();
        break;
      case OP.REDUCE:
        pop();
        throw new RpaError("unsupported pickle REDUCE in RPA index");
      case OP.GLOBAL:
        ignoreGlobal();
        break;
      case OP.STACK_GLOBAL:
        ignoreGlobal();
        break;
      case OP.INST:
      case OP.OBJ:
      case OP.NEWOBJ:
      case OP.NEWOBJ_EX:
        throw new RpaError("unsupported pickle object opcode in RPA index");
      case OP.EXT1:
      case OP.EXT2:
        read(opcode === OP.EXT1 ? 1 : 2);
        break;
      case OP.EXT4:
        read(4);
        break;
      case OP.PUT: {
        const key = Number.parseInt(read(u8()).toString("latin1"), 10);
        memo.set(key, stack[stack.length - 1]);
        break;
      }
      case OP.BINPUT: {
        memo.set(u8(), stack[stack.length - 1]);
        break;
      }
      case OP.LONG_BINPUT: {
        memo.set(u32(), stack[stack.length - 1]);
        break;
      }
      case OP.MEMOIZE: {
        memo.set(memo.size, stack[stack.length - 1]);
        break;
      }
      case OP.GET: {
        const key = Number.parseInt(read(u8()).toString("latin1"), 10);
        if (!memo.has(key)) throw new RpaError(`pickle memo miss at ${key}`);
        stack.push(memo.get(key));
        break;
      }
      case OP.BINGET: {
        const key = u8();
        if (!memo.has(key)) throw new RpaError(`pickle memo miss at ${key}`);
        stack.push(memo.get(key));
        break;
      }
      case OP.LONG_BINGET: {
        const key = u32();
        if (!memo.has(key)) throw new RpaError(`pickle memo miss at ${key}`);
        stack.push(memo.get(key));
        break;
      }
      case OP.PERSID:
      case OP.BINPERSID:
        throw new RpaError("unsupported pickle persistent reference in RPA index");
      default:
        throw new RpaError(
          `unsupported pickle opcode 0x${opcode.toString(16)} at offset ${pos - 1}`,
        );
    }
  }
  throw new RpaError("pickle stream ended without STOP");
}

/**
 * Read the index bytes at `indexOffset`, inflating them when Ren'Py wrote the
 * index deflated.
 *
 * Ren'Py does not always store the pickle index as plain text: when the index
 * is large it zlib-deflates it and points the header offset at the deflated
 * bytes, which begin with the `0x78` zlib header. Every archive shipped with
 * the games tested so far is deflated, so this is the common case rather than
 * the exception — reading the raw bytes yields `unsupported pickle opcode 0x78`.
 * @param raw the archive bytes from the header-declared index offset to EOF.
 * @param archivePath path, for error messages.
 * @returns the plain index bytes.
 */
function readIndex(raw, archivePath) {
  if (raw.length === 0) throw new RpaError(`${archivePath}: index offset is past end of file`);
  // Try to inflate rather than sniffing for the 0x78 zlib magic: a real archive
  // whose body happens to start with 0x78 at the index offset would otherwise
  // be misread as deflated. A pickle opcode is never 0x78, but archive bodies
  // are arbitrary bytes, so the only reliable test is to attempt the inflate.
  try {
    const inflated = inflateSync(raw);
    if (process.env.RPA_INDEX_DEBUG) {
      console.error(`[readIndex] inflated ok: raw=${raw.length} -> ${inflated.length}, head=${inflated.subarray(0, 24).toString("latin1")}`);
    }
    return inflated;
  } catch (error) {
    if (process.env.RPA_INDEX_DEBUG) {
      console.error(`[readIndex] inflate failed (${error.code ?? error.message}); raw[0]=0x${raw[0].toString(16)} len=${raw.length}`);
    }
    if (raw[0] === 0x78) {
      throw new RpaError(`${archivePath}: index looks zlib-deflated but could not be inflated (${error.message})`);
    }
  }
  return raw;
}

/**
 * Read `length` bytes at `offset` without loading the rest of the file.
 * The descriptor is opened per call rather than held: archives sit in a cache
 * for the life of a game, and a handle per archive would outlive every switch.
 */
function readRange(path, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(path, "r");
  try {
    let filled = 0;
    while (filled < length) {
      const count = readSync(descriptor, buffer, filled, length - filled, offset + filled);
      if (count === 0) break;
      filled += count;
    }
    if (filled < length) throw new RpaError(`${path}: unexpected end of file at ${offset + filled}`);
  } finally {
    closeSync(descriptor);
  }
  return buffer;
}

/**
 * Open one `.rpa` archive and read its index.
 * @param archivePath absolute path of the archive.
 * @returns `{ names, read(name) }` over the archive's entries.
 */
export function openRpa(archivePath) {
  // Only the header line and the index tail are read here, and an entry is
  // read from disk when asked for. Slurping the file made a 1.7 GB archive cost
  // 1.7 GB of resident memory per open (and fail outright past the Buffer
  // limit), when everything the manifest needs from it is a few hundred KB.
  const size = statSync(archivePath).size;
  const head = readRange(archivePath, 0, Math.min(size, 256));
  const newline = head.indexOf(0x0a);
  if (newline < 0) throw new RpaError(`${archivePath}: no RPA header line`);
  const header = head.toString("latin1", 0, newline);
  const parts = header.split(/\s+/);
  // RPA-2.0 (`RPA-2.0 <offset>`) is what Ren'Py 6/7-era games ship. It has no
  // header key and its index is not XOR-obfuscated, so the key is zero. The
  // reader is otherwise the same as RPA-3 (renpy/loader.py, RPAv2ArchiveHandler).
  const isV2 = parts[0] === "RPA-2.0";
  if (!isV2 && !/^RPA-3(\.0)?$/.test(parts[0])) {
    throw new RpaError(`${archivePath}: unsupported archive header ${JSON.stringify(parts[0])}`);
  }
  const indexOffset = Number.parseInt(parts[1], 16);
  const key = isV2 ? 0 : Number.parseInt(parts[2], 16);
  if (!Number.isFinite(indexOffset) || !Number.isFinite(key)) {
    throw new RpaError(`${archivePath}: malformed RPA header`);
  }
  if (indexOffset >= size) throw new RpaError(`${archivePath}: index offset is past end of file`);
  const index = unpickle(readIndex(readRange(archivePath, indexOffset, size - indexOffset), archivePath));
  if (!(index instanceof Map)) throw new RpaError(`${archivePath}: index is not a dict`);

  const entries = new Map();
  for (const [name, value] of index) {
    if (typeof name !== "string" || !Array.isArray(value)) continue;
    // Each archived name maps to a LIST of `(offset, length, prefix)` tuples —
    // the same name can appear more than once and Ren'Py keeps them all in the
    // list. Picking a candidate means picking the first one that actually fits
    // inside the archive, which is what renpy/loader.py does when it loops over
    // the list looking for an entry it can read:
    //
    //     for t in l:
    //         if len(t) == 2: t = t[0], t[1], b""
    //         try: start = t[0] ^ key; dlen = t[1] ^ key; ...
    //         except: continue
    //         return ...
    //
    // Taking `value[0]` blindly is not enough: an archive can carry a stale
    // first candidate whose numbers no longer fit, and that made a real archive
    // report zero usable entries. `value` being a bare tuple rather than a list
    // is also accepted, mirroring the `len(t) == 2` branch above.
    const candidates = Array.isArray(value[0]) ? value : [value];
    let chosen;
    for (const candidate of candidates) {
      if (!Array.isArray(candidate) || candidate.length < 2) continue;
      const offsetValue = Number(candidate[0]);
      const lengthValue = Number(candidate[1]);
      if (!Number.isFinite(offsetValue) || !Number.isFinite(lengthValue)) continue;
      // Ren'Py obfuscates both numbers with the header key before pickling
      // them, so both must come back through XOR. (`renpy/loader.py`,
      // RPAv3ArchiveHandler.read_index: `(offset ^ key, dlen ^ key)`.)
      const offset = offsetValue ^ key;
      const length = lengthValue ^ key;
      if (offset < 0 || length < 0) continue;
      const prefix = Buffer.isBuffer(candidate[2]) ? candidate[2] : Buffer.alloc(0);
      // The prefix is stored in the INDEX, not the body — Ren'Py returns
      // `prefix + f.read(dlen)` — so only `length` bytes come from the archive
      // body and `end` must be measured without it. Adding the prefix here
      // rejected every entry that had one.
      const end = offset + length;
      // An entry has to fit in the data region, which ends where the index
      // begins. Checking against the file length instead would accept an entry
      // that swallows compressed index bytes and hand them back as file
      // content, so a truncated or corrupt entry would look like a real file.
      if (end > indexOffset) continue;
      chosen = { offset, length, prefix, end };
      break;    }
    if (chosen !== undefined) entries.set(name, chosen);
  }

  if (process.env.RENPY_RPA_DEBUG) {
    console.error(
      `[rpa3] index=${index.size} usable=${entries.size} skipped=${index.size - entries.size}`,
    );
  }

  return {
    path: archivePath,
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    /**
     * Read one archived entry.
     * @param name the archived name, exactly as the index spells it.
     * @returns the entry bytes.
     */
    read(name) {
      const entry = entries.get(name);
      if (entry === undefined) throw new RpaError(`${archivePath}: no entry ${name}`);
      // The candidate was bounds-checked when the index was built, so this is
      // the same `end` that selection verified rather than a second guess.
      return Buffer.concat([entry.prefix, readRange(archivePath, entry.offset, entry.length)]);
    },
    /**
     * Logical byte length of one entry (prefix included), or `undefined`.
     * @param name the archived name.
     */
    sizeOf(name) {
      const entry = entries.get(name);
      return entry === undefined ? undefined : entry.prefix.length + entry.length;
    },
    /**
     * Read `length` bytes from `start` of one entry without the rest of it.
     * A header (image size, audio duration) is a few KiB of an entry that can
     * be megabytes; reading the whole entry for it made indexing a 4000-image
     * archive allocate its full 1.7 GB.
     * @param name the archived name.
     * @param start offset inside the logical entry.
     * @param length bytes wanted; clamped to the entry end.
     */
    slice(name, start, length) {
      const entry = entries.get(name);
      if (entry === undefined) throw new RpaError(`${archivePath}: no entry ${name}`);
      const total = entry.prefix.length + entry.length;
      const from = Math.min(Math.max(0, start), total);
      const count = Math.min(Math.max(0, length), total - from);
      if (count === 0) return Buffer.alloc(0);
      const parts = [];
      const prefixEnd = entry.prefix.length;
      if (from < prefixEnd) parts.push(entry.prefix.subarray(from, Math.min(prefixEnd, from + count)));
      const bodyFrom = Math.max(from, prefixEnd) - prefixEnd;
      const bodyCount = from + count - Math.max(from, prefixEnd);
      if (bodyCount > 0) parts.push(readRange(archivePath, entry.offset + bodyFrom, bodyCount));
      return Buffer.concat(parts);
    },
  };
}

/**
 * Whether a path is a readable regular file holding an RPA archive.
 * @param archivePath candidate path.
 */
export function isRpa(archivePath) {
  try {
    if (!statSync(archivePath).isFile()) return false;
    // Only the magic is read: this used to load the whole file as a string,
    // which throws for an archive past V8's string limit (a 1.7 GB archive
    // answered "not an archive" and the whole game vanished from the index).
    const magic = readRange(archivePath, 0, 5).toString("latin1");
    return magic === "RPA-3" || magic === "RPA-2";
  } catch {
    return false;
  }
}
