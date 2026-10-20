"""Generate RPA index fixtures with CPython's own pickler.

The reader in lib/rpa3.js has to accept what Ren'Py writes, and Ren'Py writes
CPython pickles (renpy/compat/pickle.py just calls pickle.loads). Hand-rolling
the opcode stream in JavaScript is how this test fixture went wrong the first
time: the fixture and the reader shared my misunderstanding of the format, so
they "verified" each other while both being wrong about real archives.

So the fixtures are produced here, by the same pickler Ren'Py uses, and the JS
test only wraps them in the RPA container. Regenerate with:

    python test/make-rpa-fixtures.py

Writes test/fixtures/rpa-indexes.json. Per case:

  "pickleHex"  the exact bytes pickle.dumps() produced for the index. This is
               written into the archive verbatim.
  "layout"     name -> [[absolute offset, length, prefix], ...] in plain form,
               for debugging a failure. Offsets are absolute (header included).
  "body"       the literal payload a well-formed archive would carry.
  "expect"     name -> [bytes, ...], one expected read() result per candidate.

The body is laid out so every entry points at real data rather than at offset 0:
an entry at offset 0 would address the "RPA-3.0 ..." header line itself, which is
how an earlier version of this fixture managed to look successful while checking
nothing.
"""
import json
import os
import pickle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "rpa-indexes.json")

# Ren'Py XORs offset and length with the header key BEFORE pickling, so the
# values that reach pickle.dumps are already obfuscated. The reader XORs them
# back. (`renpy/loader.py`, RPAv3ArchiveHandler.read_index.)
KEY = 0x42424242

# The archive header the JS test writes is exactly 26 bytes:
# "RPA-3.0 " (8) + 8 hex digits (8) + " " (1) + 8 hex digits (8) + "\n" (1).
HEADER_LENGTH = 26

# Ren'Py stores ABSOLUTE offsets: an entry's offset is its distance from the
# first byte of the archive, so the header is included. (The loader seeks with
# `f.seek(start)` on a file opened at position 0, then reads `dlen` bytes.) The
# cases below are written in body-relative terms for readability and shifted by
# the header here, which is why the test's `read()` results are unshifted.
#
# Getting this wrong is not cosmetic: with body-relative offsets the reader
# happily returned the right LENGTH of the wrong bytes, shifting every payload by
# the header and corrupting the last 26 bytes of the file.
HEADER_SHIFT = HEADER_LENGTH


def xor(value):
    return value ^ KEY


def case(body: bytes, entries: dict, expect: dict):
    """Build one fixture case.

    `entries` is name -> [(offset, length, prefix), ...] with offsets given
    RELATIVE TO THE BODY (0 = first body byte); the archive header shift is
    applied here. Values are obfuscated the way Ren'Py does before pickling.
    `expect` is name -> [bytes, ...], one expected `read()` result per
    candidate, stated explicitly so the fixture cannot quietly disagree with
    itself the way a derived expectation can.
    """
    index = {}
    layout = {}
    for name, candidates in entries.items():
        index[name] = [
            (xor(offset + HEADER_SHIFT), xor(length), prefix)
            for offset, length, prefix in candidates
        ]
        # `layout` is the plain, human-readable form for whoever has to debug a
        # failure. It is NOT what gets written into the archive: an earlier
        # version reused the obfuscated numbers here and then obfuscated them a
        # second time, so the fixture described a different archive than the one
        # it produced.
        layout[name] = [
            [offset + HEADER_SHIFT, length, prefix.decode("latin1")]
            for offset, length, prefix in candidates
        ]
    stream = pickle.dumps(index, 5)
    return {
        "pickleHex": stream.hex(),
        "layout": layout,
        "body": body.decode("latin1"),
        "expect": {name: [value.decode("latin1") for value in values] for name, values in expect.items()},
    }


SCRIPT = b"# hello from Ren'Py\nlabel start:\n    return\n---"
PNG = b"\x89PNG\r\n\x1a\n-fake-png-bytes"
MP3 = b"ID3\x04\x00fake-mp3-payload"
# The repeat body holds two non-overlapping ranges so a well-formed entry can
# point at either one; the test asserts read() returns the FIRST candidate's
# bytes, which is what proves selection did not silently advance. It is long
# enough that both candidates fit before the index begins — an entry is only
# usable if it ends by then, and a short body would have quietly made the second
# candidate unreadable and failed the test for the wrong reason.
#
# ARITHMETIC THAT BIT ME: "SECOND" has to START exactly at body offset 114,
# because the candidates below say (114, 6). With 114 padding nulls it started
# at 119, and the reader — correctly reading offset 114 — returned five nulls
# plus "S" while the test expected "SECOND". The reader was right; the fixture
# described an archive whose layout disagreed with its own expectations.
REPEAT_BODY = b"AAAAA" + b"\x00" * 109 + b"SECOND"

fixtures = {
    # one file, the common case
    "simple": case(
        SCRIPT,
        {"scripts/start.rpy": [(0, len(SCRIPT), b"")]},
        {"scripts/start.rpy": [SCRIPT]},
    ),
    # several names, exercising the memo table and multiple list entries
    "multi": case(
        SCRIPT + PNG + MP3,
        {
            "scripts/start.rpy": [(0, len(SCRIPT), b"")],
            "gui/bar.png": [(len(SCRIPT), len(PNG), b"")],
            "audio/click.mp3": [(len(SCRIPT) + len(PNG), len(MP3), b"")],
        },
        {
            "scripts/start.rpy": [SCRIPT],
            "gui/bar.png": [PNG],
            "audio/click.mp3": [MP3],
        },
    ),
    # a non-empty index prefix: the first bytes live in the index and must be
    # prepended to the bytes that come from the body
    "prefix": case(
        b"OF-IT",
        {"p.txt": [(0, 5, b"PREFIXED")]},
        {"p.txt": [b"PREFIXED" + b"OF-IT"]},
    ),
    # the same name twice with an in-range first candidate: Ren'Py keeps both in
    # one list and uses the first, so read() must return the first candidate's
    # bytes rather than the later one
    "repeated-name": case(
        REPEAT_BODY,
        {"dup.txt": [(0, 5, b""), (114, 6, b"")]},
        {"dup.txt": [REPEAT_BODY[0:5], REPEAT_BODY[114:120]]},
    ),
    # a stale first candidate whose numbers no longer fit the archive: selection
    # has to advance to the candidate that does fit
    "stale-first": case(
        REPEAT_BODY,
        {"dup.txt": [(0x7FFFFF00, 5, b""), (114, 6, b"")]},
        {"dup.txt": [REPEAT_BODY[114:120]]},
    ),    # offsets above 2^31: these only survive if the reader handles the wider
    # integer encodings pickle picks for big values
    "wide-offsets": case(
        b"abc",
        {"big.rpa": [(0x70000000, 3, b"")]},
        {"big.rpa": [b"abc"]},
    ),
}

for label, fixture in fixtures.items():
    print(
        f"{label:14} pickle={len(bytes.fromhex(fixture['pickleHex'])):4}B "
        f"body={len(fixture['body']):4}B entries={len(fixture['layout'])}"
    )

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as handle:
    json.dump(fixtures, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
print(f"\nwrote {OUT} (header length {HEADER_LENGTH}, key 0x{KEY:x})")