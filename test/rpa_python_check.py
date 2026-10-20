"""Independent check of Ren'Py's RPA-3.0 index, in plain CPython.

Mirrors renpy/loader.py RPAv3ArchiveHandler.read_index exactly, so we can see
what a real unpickler makes of an archive without trusting our own opcode VM.
"""
import sys, zlib, pickle

path = sys.argv[1]
with open(path, "rb") as f:
    head = f.read(40)
    offset = int(head[8:24], 16)
    key = int(head[25:33], 16)
    f.seek(offset)
    raw = f.read()

print(f"header  = {head!r}")
print(f"offset  = {offset}")
print(f"key     = 0x{key:08x}")
print(f"raw idx = {len(raw)} bytes, first 4 = {raw[:4].hex()}")

try:
    inflated = zlib.decompress(raw)
except Exception as exc:
    print(f"zlib failed: {exc!r}")
    sys.exit(1)
print(f"inflated= {len(inflated)} bytes")
print(f"  first 32 hex = {inflated[:32].hex()}")

try:
    index = pickle.loads(inflated)
except Exception as exc:
    print(f"pickle.loads FAILED: {type(exc).__name__}: {exc}")
    sys.exit(2)

print(f"pickle.loads OK: {type(index).__name__} with {len(index)} entries")
names = list(index.keys())
for n in names[:3]:
    print(f"  {n!r} -> {index[n]!r}")
