// Duration probing for the audio containers Ren'Py games ship. Every fixture
// here is built byte by byte rather than committed as a file, because a
// hand-written fixture that reuses the parser's own misunderstanding of a
// header "verifies" nothing — the point of these buffers is that the field
// offsets are spelled out independently of lib/audio.js.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DURATION_EXTENSIONS, readAudioDuration } from "../lib/audio.js";

/**
 * A real RIFF/WAVE file with `seconds` of PCM. byteRate = rate * channels *
 * bits/8, and duration is dataSize / byteRate, so generating the data chunk
 * from byteRate is what makes the expected value non-circular.
 */
function makeWav(seconds, { sampleRate = 8000, channels = 1, bits = 16, claimedDataSize } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28); // the field the duration divides by
  buf.writeUInt16LE((channels * bits) / 8, 32); // block align
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(claimedDataSize ?? dataSize, 40);
  return buf;
}

/** A minimal MPEG1 Layer III stereo frame header: 128 kbps, 44100 Hz. */
function mp3FrameHeader() {
  return Buffer.from([0xff, 0xfb, 0x90, 0x40]);
}

/**
 * An MP3 with an ID3v2 tag, one MPEG1 Layer III frame, and optionally a Xing
 * tag declaring `frames` frames. `fillFrames` pads the file with more frame
 * headers so the CBR estimate has something realistic to divide.
 */
function makeMp3({ id3BodySize = 100, xingFrames = null, fillFrames = 0 } = {}) {
  const id3 = Buffer.alloc(10 + id3BodySize);
  id3.write("ID3", 0, "latin1");
  id3[3] = 3; // version
  id3[4] = 0;
  id3[5] = 0; // flags: no footer
  // Syncsafe size: 4 bytes of 7 bits, high bit always clear.
  id3[6] = (id3BodySize >> 21) & 0x7f;
  id3[7] = (id3BodySize >> 14) & 0x7f;
  id3[8] = (id3BodySize >> 7) & 0x7f;
  id3[9] = id3BodySize & 0x7f;

  const frameLength = Math.floor((144 * 128000) / 44100 + 0); // 417 bytes
  const frame = Buffer.alloc(frameLength);
  mp3FrameHeader().copy(frame, 0);
  // Xing sits after the 4-byte header plus 32 bytes of stereo side info.
  if (xingFrames !== null) {
    frame.write("Xing", 36, "latin1");
    frame.writeUInt32BE(0x01, 40); // flags: frame count present
    frame.writeUInt32BE(xingFrames, 44);
  }

  const frames = [frame];
  for (let i = 0; i < fillFrames; i++) {
    const extra = Buffer.alloc(frameLength);
    mp3FrameHeader().copy(extra, 0);
    frames.push(extra);
  }
  return Buffer.concat([id3, ...frames]);
}

/** One Ogg page with a correctly built segment table (up to 255-byte lacing). */
function oggPage({ serial = 1, seq = 0, headerType = 0, granuleLo = 0, granuleHi = 0, payload }) {
  const lacing = [];
  let remaining = payload.length;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  lacing.push(remaining);

  const buf = Buffer.alloc(27 + lacing.length + payload.length);
  buf.write("OggS", 0, "latin1");
  buf[4] = 0; // stream structure version
  buf[5] = headerType;
  buf.writeUInt32LE(granuleLo >>> 0, 6);
  buf.writeUInt32LE(granuleHi >>> 0, 10);
  buf.writeUInt32LE(serial, 14);
  buf.writeUInt32LE(seq, 18);
  // CRC at 22 is left zero: lib/audio.js never validates it.
  buf[26] = lacing.length;
  lacing.forEach((value, index) => {
    buf[27 + index] = value;
  });
  payload.copy(buf, 27 + lacing.length);
  return buf;
}

/** A Vorbis identification packet: 0x01 "vorbis", version, channels, rate. */
function vorbisIdPacket(sampleRate, channels = 2) {
  const buf = Buffer.alloc(30);
  buf[0] = 0x01;
  buf.write("vorbis", 1, "latin1");
  buf.writeUInt32LE(0, 7); // vorbis version at 7..10
  buf[11] = channels; // channels is a single byte
  buf.writeUInt32LE(sampleRate, 12); // rate, the field the granule divides by
  return buf;
}

test("readAudioDuration divides a WAV data chunk by byteRate", () => {
  // Symptom this pins: a 1-second 8000 Hz 16-bit mono file (16000 bytes of
  // data at 16000 bytes/second) reported as 2 seconds because the block align
  // was used as the byte rate.
  const wav = makeWav(1);
  assert.equal(wav.length, 44 + 16000);
  const duration = readAudioDuration(wav, wav, wav.length, ".wav");
  assert.ok(Math.abs(duration - 1) < 0.001, `expected 1s, got ${duration}`);
});

test("readAudioDuration classifies short and long WAVs for the 10s filter", () => {
  // The caller's only consumer is a "drop stingers of 10 seconds or less"
  // filter, so the boundary must fall on the correct side for real lengths.
  const long = makeWav(12);
  const short = makeWav(3);
  const longDuration = readAudioDuration(long, long, long.length, ".wav");
  const shortDuration = readAudioDuration(short, short, short.length, ".wav");
  assert.ok(longDuration > 10, `12s WAV came back as ${longDuration}`);
  assert.ok(shortDuration < 10, `3s WAV came back as ${shortDuration}`);
});

test("readAudioDuration reads a WAV whose fmt chunk is WAVE_FORMAT_EXTENSIBLE", () => {
  // Real Ren'Py games ship 0xFFFE fmt chunks; byteRate is still at +8 from the
  // chunk body even though extra fields follow the classic 16 bytes.
  const wav = makeWav(2);
  wav.writeUInt16LE(0xfffe, 20);
  const duration = readAudioDuration(wav, wav, wav.length, ".wav");
  assert.ok(Math.abs(duration - 2) < 0.001, `expected 2s, got ${duration}`);
});

test("readAudioDuration prefers the Xing frame count in an MP3", () => {
  // Symptom this pins: an MP3 with an ID3v2 tag read as ~0 seconds because the
  // parser started at byte 0 and treated the tag body as audio.
  const mp3 = makeMp3({ xingFrames: 1000 });
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  const expected = (1000 * 1152) / 44100;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration falls back to a CBR estimate without a Xing tag", () => {
  // Not exact and not meant to be: the frame count only exists when the
  // encoder wrote a Xing/Info/VBRI tag, so the estimate just has to be finite
  // and on the right side of the 10s filter.
  const mp3 = makeMp3({ xingFrames: null, fillFrames: 99 });
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  assert.ok(Number.isFinite(duration) && duration > 0, `got ${duration}`);
  // (size - firstFrameOffset) * 8 / 128000, with a 417-byte frame.
  assert.ok(Math.abs(duration - (100 * 417 * 8) / 128000) < 0.3, `got ${duration}`);
});

test("readAudioDuration reads the MP3 bitrate from the header, not a constant", () => {
  // A 320 kbps frame must come back roughly 2.5x shorter than a 128 kbps one;
  // a hardcoded 128 would make them identical.
  const fast = makeMp3({ xingFrames: null, fillFrames: 99 });
  const slow = Buffer.from(fast);
  slow[110 + 2] = (14 << 4) | 0x00; // bitrate index 14 = 320 kbps, 44100 Hz
  const fastDuration = readAudioDuration(fast, fast, fast.length, ".mp3");
  const slowDuration = readAudioDuration(slow, slow, slow.length, ".mp3");
  assert.ok(slowDuration < fastDuration, `${slowDuration} should be shorter than ${fastDuration}`);
});

test("readAudioDuration divides an Ogg granule by the Vorbis sample rate", () => {
  // Symptom this pins: Vorbis audio at 8 kHz reported 5.5x long because the
  // granule was divided by a hardcoded 44100.
  const head = oggPage({ seq: 0, payload: vorbisIdPacket(8000) });
  const last = oggPage({ seq: 1, headerType: 0x04, granuleLo: 8000 * 7, payload: Buffer.alloc(8) });
  const file = Buffer.concat([head, last]);
  const tail = file.subarray(file.length - 60);
  const duration = readAudioDuration(file, tail, file.length, ".ogg");
  assert.ok(Math.abs(duration - 7) < 0.001, `expected 7s, got ${duration}`);
});

test("readAudioDuration ignores a non-EOS page and keeps scanning backwards", () => {
  // When an encoder dies mid-stream the last page has no end-of-stream bit and
  // its granule is 0; the newest page that does end the stream still wins.
  const head = oggPage({ seq: 0, payload: vorbisIdPacket(44100) });
  const last = oggPage({ seq: 1, headerType: 0x04, granuleLo: 44100 * 5, payload: Buffer.alloc(8) });
  const dangling = oggPage({ seq: 2, headerType: 0x00, granuleLo: 0, payload: Buffer.alloc(8) });
  const file = Buffer.concat([head, last, dangling]);
  const tail = file.subarray(file.length - 80);
  const duration = readAudioDuration(file, tail, file.length, ".ogg");
  assert.ok(Math.abs(duration - 5) < 0.001, `expected 5s, got ${duration}`);
});

test("readAudioDuration divides an Opus granule by 48000", () => {
  // Opus granules are always 48 kHz regardless of the rate in OpusHead, so a
  // 240000 granule is 5 seconds, not 5.44 (48/44.1) or similar.
  const head = oggPage({ seq: 0, payload: Buffer.from("OpusHead", "latin1") });
  const last = oggPage({ seq: 1, headerType: 0x04, granuleLo: 240000, payload: Buffer.alloc(8) });
  const file = Buffer.concat([head, last]);
  const tail = file.subarray(file.length - 60);
  const duration = readAudioDuration(file, tail, file.length, ".opus");
  assert.ok(Math.abs(duration - 5) < 0.001, `expected 5s, got ${duration}`);
});

test("readAudioDuration rejects an Opus page whose granule is still unwritten", () => {
  // A file being written right now has the all-ones granule placeholder;
  // reporting 4.29e9/48000 seconds would keep a garbage track forever.
  const head = oggPage({ seq: 0, payload: Buffer.from("OpusHead", "latin1") });
  const last = oggPage({
    seq: 1,
    headerType: 0x04,
    granuleLo: 0xffffffff,
    granuleHi: 0xffffffff,
    payload: Buffer.alloc(8),
  });
  const file = Buffer.concat([head, last]);
  const duration = readAudioDuration(file, file, file.length, ".opus");
  assert.equal(duration, undefined);
});

test("readAudioDuration reads FLAC STREAMINFO sample count over rate", () => {
  // FLAC is the one lossless format whose duration is exact from the header:
  // 36-bit total samples / 20-bit sample rate. 44100 * 3 = 3 seconds.
  const buf = Buffer.alloc(4 + 4 + 34);
  buf.write("fLaC", 0, "latin1");
  buf[4] = 0x00; // STREAMINFO, not last
  buf.writeUIntBE(34, 5, 3);
  const body = 8;
  const packed = (44100 << 12) | ((2 - 1) << 9) | ((16 - 1) << 4) | 0; // high 4 bits of total samples
  buf.writeUInt32BE(packed >>> 0, body + 10);
  buf.writeUInt32BE(44100 * 3, body + 14); // low 32 bits
  const duration = readAudioDuration(buf, buf, buf.length, ".flac");
  assert.ok(Math.abs(duration - 3) < 0.001, `expected 3s, got ${duration}`);
});

test("readAudioDuration never throws on an empty file", () => {
  // The asset scanner calls this for every file it sees, including zero-byte
  // ones a failed copy left behind; a throw would abort discovery for the game.
  assert.equal(readAudioDuration(Buffer.alloc(0), Buffer.alloc(0), 0, ".mp3"), undefined);
  assert.equal(readAudioDuration(Buffer.alloc(0), Buffer.alloc(0), 0, ".wav"), undefined);
  assert.equal(readAudioDuration(Buffer.alloc(0), Buffer.alloc(0), 0, ".ogg"), undefined);
});

test("readAudioDuration survives a WAV whose data chunk overruns the file", () => {
  // A download that died half-way leaves `data` claiming 0xFFFFFFFF bytes; the
  // documented fallback is to measure from the data offset to the true EOF.
  const truncated = makeWav(1, { claimedDataSize: 0xffffffff });
  const duration = readAudioDuration(truncated, truncated, truncated.length, ".wav");
  assert.ok(Math.abs(duration - 1) < 0.001, `expected the EOF fallback, got ${duration}`);
});

test("readAudioDuration uses the EOF fallback when a WAV data size is merely wrong", () => {
  // Same shape without the sentinel: a header promising 100 seconds over 1
  // second of bytes must not report 100 seconds of music.
  const lying = makeWav(1, { claimedDataSize: 16000 * 100 });
  const duration = readAudioDuration(lying, lying, lying.length, ".wav");
  assert.ok(Math.abs(duration - 1) < 0.001, `expected 1s, got ${duration}`);
});

test("readAudioDuration returns undefined for buffers that are pure noise", () => {
  // Anything unrecognised is "unknown, keep the track"; guessing here is how a
  // random resource ends up in the music playlist.
  const bogus = Buffer.alloc(4096, 0xa5);
  for (const ext of [".mp3", ".wav", ".ogg", ".opus", ".flac"]) {
    assert.equal(readAudioDuration(bogus, bogus, bogus.length, ext), undefined, ext);
  }
});

test("readAudioDuration returns undefined for very short heads and bad arguments", () => {
  // The caller passes head.length === min(size, 65536), so a 4-byte file is
  // legal input and must not reach a readUInt32LE past the end.
  const tiny = Buffer.from([0x52, 0x49, 0x46, 0x46]);
  assert.equal(readAudioDuration(tiny, tiny, 4, ".wav"), undefined);
  assert.equal(readAudioDuration(tiny, tiny, 4, ".flac"), undefined);
  assert.equal(readAudioDuration(tiny, tiny, 4, ".mp3"), undefined);
  assert.equal(readAudioDuration(undefined, undefined, 10, ".mp3"), undefined);
  assert.equal(readAudioDuration(tiny, tiny, Number.NaN, ".mp3"), undefined);
  assert.equal(readAudioDuration(tiny, tiny, 4, undefined), undefined);
});

test("readAudioDuration reads a VBRI frame count when there is no Xing tag", () => {
  // Fraunhofer encoders write VBRI instead of Xing. Symptom this pins: a VBRI
  // file silently falling through to the CBR estimate, which reports a wrong
  // length for every VBR file the encoder produced.
  const frameLength = Math.floor((144 * 128000) / 44100);
  const frame = Buffer.alloc(frameLength);
  mp3FrameHeader().copy(frame, 0);
  // VBRI is always 36 bytes into the frame (32 bytes of stereo side info + 4).
  frame.write("VBRI", 36, "latin1");
  frame.writeUInt16BE(1, 40); // version
  frame.writeUInt16BE(0, 42); // delay
  frame.writeUInt16BE(0, 44); // quality
  frame.writeUInt32BE(500, 46); // bytes
  frame.writeUInt32BE(750, 50); // frame count, at +14 from the tag start
  const mp3 = frame; // no ID3, no Xing — the frame starts at offset 0
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  const expected = (750 * 1152) / 44100;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration uses the MPEG2 Layer III tables for low sample rates", () => {
  // MPEG2/2.5 Layer III is 576 samples per frame and its bitrate table is not
  // the MPEG1 one; using 1152 and the MPEG1 table doubles the duration of every
  // stream a low-bitrate encoder emits.
  const header = Buffer.from([0xff, 0xe3, 0x80, 0x00]); // MPEG2.5, Layer III, 64kbps, 11025Hz, stereo
  const frameLength = Math.floor((72 * 64000) / 11025);
  const frame = Buffer.alloc(frameLength);
  header.copy(frame, 0);
  frame.write("Xing", 21, "latin1"); // 4 header + 17 bytes of stereo side info
  frame.writeUInt32BE(0x01, 25);
  frame.writeUInt32BE(2000, 29);
  const duration = readAudioDuration(frame, frame, frame.length, ".mp3");
  const expected = (2000 * 576) / 11025;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration skips the extra 10 bytes of an ID3v2 footer", () => {
  // The footer flag adds 10 bytes the size field does not count. Symptom this
  // pins: the parser landing 10 bytes into the first frame and reporting no
  // duration at all for tagged files.
  const id3 = Buffer.alloc(10 + 100 + 10);
  id3.write("ID3", 0, "latin1");
  id3[3] = 4;
  id3[5] = 0x10; // footer present
  id3[9] = 100; // syncsafe size, body only
  const frame = Buffer.alloc(Math.floor((144 * 128000) / 44100));
  mp3FrameHeader().copy(frame, 0);
  frame.write("Xing", 36, "latin1");
  frame.writeUInt32BE(0x01, 40);
  frame.writeUInt32BE(1000, 44);
  const mp3 = Buffer.concat([id3, frame]);
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  const expected = (1000 * 1152) / 44100;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration skips an ID3v2 body instead of resyncing inside it", () => {
  // Symptom this pins: a real MP3 whose album art contained an `FF E0`-style
  // byte pair (JPEG APPn markers) was read as 0.1s because the parser started
  // its frame scan at byte 0 and locked onto the cover image instead of the
  // audio. The decoy below is that false sync, including the fake Xing tag it
  // would carry; only honouring the ID3v2 size reaches the real frame count.
  const id3 = Buffer.alloc(10 + 100);
  id3.write("ID3", 0, "latin1");
  id3[3] = 3;
  id3[9] = 100;
  mp3FrameHeader().copy(id3, 30); // decoy frame inside the tag body
  id3.write("Xing", 30 + 36, "latin1");
  id3.writeUInt32BE(0x01, 30 + 40);
  id3.writeUInt32BE(5, 30 + 44); // 5 frames => 0.13s, nothing like the truth

  const real = Buffer.alloc(Math.floor((144 * 128000) / 44100));
  mp3FrameHeader().copy(real, 0);
  real.write("Xing", 36, "latin1");
  real.writeUInt32BE(0x01, 40);
  real.writeUInt32BE(1000, 44);

  const mp3 = Buffer.concat([id3, real]);
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  const expected = (1000 * 1152) / 44100;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration counts the ID3v2 footer in the audio start offset", () => {
  // The footer flag adds 10 bytes the syncsafe size field does not count. The
  // symptom is an audio start 10 bytes early; pinning the arithmetic needs a
  // decoy frame sitting in those footer bytes, because the scan would otherwise
  // resync onto the real frame and hide the error.
  const id3 = Buffer.alloc(10 + 100 + 10);
  id3.write("ID3", 0, "latin1");
  id3[3] = 4;
  id3[5] = 0x10; // footer present
  id3[9] = 100; // body size only, footer excluded
  mp3FrameHeader().copy(id3, 110); // decoy occupying the footer bytes

  const real = Buffer.alloc(Math.floor((144 * 128000) / 44100));
  mp3FrameHeader().copy(real, 0);
  real.write("Xing", 36, "latin1");
  real.writeUInt32BE(0x01, 40);
  real.writeUInt32BE(1000, 44);

  const mp3 = Buffer.concat([id3, real]);
  const duration = readAudioDuration(mp3, mp3, mp3.length, ".mp3");
  const expected = (1000 * 1152) / 44100;
  assert.ok(Math.abs(duration - expected) < 0.001, `expected ${expected}, got ${duration}`);
});

test("readAudioDuration prefers the EOS page over a later non-EOS page", () => {
  // Symptom this pins: a stream with an appended page after the end-of-stream
  // marker reported the appended page's granule (9s here) instead of the
  // authoritative EOS granule (5s), lengthening played tracks at random.
  const head = oggPage({ seq: 0, payload: vorbisIdPacket(44100) });
  const eos = oggPage({ seq: 1, headerType: 0x04, granuleLo: 44100 * 5, payload: Buffer.alloc(8) });
  const appended = oggPage({ seq: 2, headerType: 0x00, granuleLo: 44100 * 9, payload: Buffer.alloc(8) });
  const file = Buffer.concat([head, eos, appended]);
  const tail = file.subarray(file.length - 80);
  const duration = readAudioDuration(file, tail, file.length, ".ogg");
  assert.ok(Math.abs(duration - 5) < 0.001, `expected 5s, got ${duration}`);
});

test("readAudioDuration falls back past a still-writing granule placeholder", () => {
  // A half-written trailing page carries the all-ones placeholder. Reporting
  // 'undefined' there would discard a perfectly measurable track, so the scan
  // must keep going back to the real EOS page.
  const head = oggPage({ seq: 0, payload: vorbisIdPacket(44100) });
  const eos = oggPage({ seq: 1, headerType: 0x04, granuleLo: 44100 * 6, payload: Buffer.alloc(8) });
  const partial = oggPage({
    seq: 2,
    headerType: 0x04,
    granuleLo: 0xffffffff,
    granuleHi: 0xffffffff,
    payload: Buffer.alloc(8),
  });
  const file = Buffer.concat([head, eos, partial]);
  const tail = file.subarray(file.length - 80);
  const duration = readAudioDuration(file, tail, file.length, ".ogg");
  assert.ok(Math.abs(duration - 6) < 0.001, `expected the EOS fallback 6s, got ${duration}`);
});

test("readAudioDuration rejects an absurd duration instead of returning it", () => {
  // A corrupt byteRate of 1 turns a real 6-second, 96000-byte data chunk into
  // 96000 seconds. Emitting that would keep a junk track forever, so anything
  // past 24 hours is treated as a broken header rather than a long song.
  const wav = makeWav(6);
  assert.equal(wav.length, 44 + 96000);
  wav.writeUInt32LE(1, 28); // byteRate = 1, so dataSize/1 exceeds 24h
  assert.equal(readAudioDuration(wav, wav, wav.length, ".wav"), undefined);
});

test("readAudioDuration returns undefined for formats it deliberately skips", () => {
  // `.m4a` needs the sample count from inside the compressed moov/stts atom
  // tree; guessing is worse than reporting "unknown" and keeping the track.
  // `.aiff` and `.wma` are not Ren'Py formats and are not implemented either.
  const data = Buffer.alloc(4096, 0x11);
  for (const ext of [".m4a", ".aiff", ".wma", ".txt", ""]) {
    assert.equal(readAudioDuration(data, data, data.length, ext), undefined, ext);
  }
});

test("DURATION_EXTENSIONS matches the formats that produce a duration", () => {
  // The set is the caller's allow-list; a format in the set that always
  // returns undefined would silently cost the game its music.
  assert.deepEqual([...DURATION_EXTENSIONS].sort(), [".flac", ".mp3", ".ogg", ".opus", ".wav"]);
  const sample = Buffer.alloc(4096, 0x22);
  for (const ext of DURATION_EXTENSIONS) {
    // Every probe is wrapped, so nothing here may throw even on junk input.
    assert.doesNotThrow(() => readAudioDuration(sample, sample, sample.length, ext), ext);
  }
});

test("readAudioDuration accepts an extension without a leading dot", () => {
  // The caller spells extensions ".ogg", but a manifest key that dropped the
  // dot must not turn a readable track into an unknown one.
  const wav = makeWav(4);
  const duration = readAudioDuration(wav, wav, wav.length, "WAV");
  assert.ok(Math.abs(duration - 4) < 0.001, `expected 4s, got ${duration}`);
});
