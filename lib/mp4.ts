/**
 * Reading an MP4's boxes, so the video tools can be checked against something
 * they did not write.
 *
 * etoolbox carries its own MP4 reader in five tools (its CLAUDE.md names them
 * as deliberate copies kept in step by a duplicate test), so asking one of
 * those what a file contains would be asking a tool to mark its own work.
 * This walks the box tree far enough to answer the questions the tests need -
 * how long, how big, how many tracks of what kind - and no further. It does
 * not decode a single sample.
 */

export interface Mp4Box {
  type: string;
  start: number;
  /** Offset of the box's payload, past the size and type (and largesize). */
  dataStart: number;
  end: number;
}

/** Boxes that hold other boxes rather than fields. */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf', 'mvex', 'dinf',
]);

/** Every box directly inside the range, shallowly. */
export function boxesIn(bytes: Buffer, start = 0, end = bytes.length): Mp4Box[] {
  const out: Mp4Box[] = [];
  let at = start;

  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    let dataStart = at + 8;

    if (size === 1) { // 64-bit size
      if (at + 16 > end) break;
      size = Number(bytes.readBigUInt64BE(at + 8));
      dataStart = at + 16;
    } else if (size === 0) {
      size = end - at; // runs to the end of the file
    }

    if (size < 8 || at + size > end) break;

    out.push({ type, start: at, dataStart, end: at + size });
    at += size;
  }

  return out;
}

/** Depth-first search for the first box of a type. */
export function findBox(bytes: Buffer, type: string, start = 0, end = bytes.length): Mp4Box | null {
  for (const box of boxesIn(bytes, start, end)) {
    if (box.type === type) return box;
    if (CONTAINERS.has(box.type)) {
      const inner = findBox(bytes, type, box.dataStart, box.end);
      if (inner) return inner;
    }
  }
  return null;
}

/** Every box of a type, at any depth. */
export function findBoxes(bytes: Buffer, type: string, start = 0, end = bytes.length): Mp4Box[] {
  const out: Mp4Box[] = [];
  for (const box of boxesIn(bytes, start, end)) {
    if (box.type === type) out.push(box);
    if (CONTAINERS.has(box.type)) out.push(...findBoxes(bytes, type, box.dataStart, box.end));
  }
  return out;
}

export interface Mp4Track {
  /** 'vide', 'soun', or whatever else the handler declares. */
  kind: string;
  /** Only meaningful for a video track; from tkhd's 16.16 fixed-point fields. */
  width: number;
  height: number;
  /** Seconds, from this track's own mdhd. */
  seconds: number;
  /**
   * Degrees clockwise that tkhd's display matrix turns the picture - 0, 90,
   * 180 or 270 - or null for a matrix that is none of those four. This is how
   * a phone says a clip was filmed sideways, and how the rotator turns one
   * without touching a frame.
   */
  rotation: number | null;
  /** The first sample entry's four-character code in stsd: avc1, hvc1, mp4a... */
  codec: string | null;
  /**
   * How many samples the track has: from stsz, or, for a fragmented file
   * whose stsz says none, counted out of the fragments' trun boxes.
   */
  samples: number;
  /** tkhd's track_ID, which the fragments name their samples by. */
  id: number;
  /**
   * Each sample's duration in seconds, in order, from stts on the track's own
   * clock. For a video track that is the time each frame is shown for.
   */
  durations: number[];
}

/** The rotation a tkhd matrix encodes, by its four rotation entries. */
const ROTATIONS: Record<string, number> = {
  '1,0,0,1': 0, '0,1,-1,0': 90, '-1,0,0,-1': 180, '0,-1,1,0': 270,
};

/** Past this many samples a stts is being read from something broken. */
const ENOUGH_SAMPLES = 200_000;

export interface Mp4 {
  brand: string;
  /** Seconds, from mvhd. Fragmented files often say zero here. */
  seconds: number;
  tracks: Mp4Track[];
  fragmented: boolean;
}

function readTrack(bytes: Buffer, trak: Mp4Box): Mp4Track | null {
  const tkhd = findBox(bytes, 'tkhd', trak.dataStart, trak.end);
  const hdlr = findBox(bytes, 'hdlr', trak.dataStart, trak.end);
  const mdhd = findBox(bytes, 'mdhd', trak.dataStart, trak.end);
  if (!tkhd) return null;

  const version = bytes[tkhd.dataStart];
  // tkhd's width and height are the last eight bytes of the box, as 16.16.
  const width = bytes.readUInt32BE(tkhd.end - 8) / 65536;
  const height = bytes.readUInt32BE(tkhd.end - 4) / 65536;

  let kind = 'unknown';
  if (hdlr) kind = bytes.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12).toString('latin1');

  let seconds = 0;
  let timescale = 0;
  if (mdhd) {
    const mdhdVersion = bytes[mdhd.dataStart];
    if (mdhdVersion === 1) {
      timescale = bytes.readUInt32BE(mdhd.dataStart + 20);
      const duration = Number(bytes.readBigUInt64BE(mdhd.dataStart + 24));
      seconds = timescale ? duration / timescale : 0;
    } else {
      timescale = bytes.readUInt32BE(mdhd.dataStart + 12);
      const duration = bytes.readUInt32BE(mdhd.dataStart + 16);
      seconds = timescale ? duration / timescale : 0;
    }
  }

  // The matrix is the 36 bytes before width and height, nine 16.16 numbers
  // (the last is 2.30) laid out a, b, u, c, d, v, x, y, w. Rotation is in a,
  // b, c and d; the translation that keeps a turned picture on screen is in
  // x and y and does not change which way up it is.
  let rotation: number | null = null;
  if (tkhd.end - 44 >= tkhd.dataStart) {
    const at = tkhd.end - 44;
    const entry = (offset: number) => Math.round(bytes.readInt32BE(at + offset) / 65536);
    rotation = ROTATIONS[`${entry(0)},${entry(4)},${entry(12)},${entry(16)}`] ?? null;
  }

  // stsd: version and flags, an entry count, then the entries, each starting
  // with its own size and four-character code.
  const stsd = findBox(bytes, 'stsd', trak.dataStart, trak.end);
  const codec = stsd && stsd.end - stsd.dataStart >= 16
    ? bytes.subarray(stsd.dataStart + 12, stsd.dataStart + 16).toString('latin1')
    : null;

  const stsz = findBox(bytes, 'stsz', trak.dataStart, trak.end);
  const samples = stsz && stsz.end - stsz.dataStart >= 12 ? bytes.readUInt32BE(stsz.dataStart + 8) : 0;

  // stts: version and flags, an entry count, then (count, delta) pairs - a
  // run of samples that all last `delta` ticks.
  const durations: number[] = [];
  const stts = findBox(bytes, 'stts', trak.dataStart, trak.end);
  if (stts && timescale && stts.end - stts.dataStart >= 8) {
    const entries = bytes.readUInt32BE(stts.dataStart + 4);
    for (let i = 0; i < entries && stts.dataStart + 16 + i * 8 <= stts.end; i += 1) {
      const count = bytes.readUInt32BE(stts.dataStart + 8 + i * 8);
      const delta = bytes.readUInt32BE(stts.dataStart + 12 + i * 8);
      for (let n = 0; n < count && durations.length < ENOUGH_SAMPLES; n += 1) {
        durations.push(delta / timescale);
      }
    }
  }

  // The track's id, for matching the fragments that carry its samples when
  // the file is fragmented: after version and flags come two timestamps, of
  // four bytes each in version 0 and eight in version 1.
  const id = bytes.readUInt32BE(tkhd.dataStart + (version === 1 ? 20 : 12));
  return { kind, width, height, seconds, rotation, codec, samples, durations, id };
}

/**
 * Samples counted out of the fragments, by track, for a file whose moov
 * declares none. A MediaRecorder writes exactly that: an empty sample table
 * up front and every sample in a run of moof/traf/trun boxes after it, each
 * trun starting with its own count.
 */
function fragmentedSamples(bytes: Buffer): Map<number, number> {
  const counts = new Map<number, number>();
  for (const traf of findBoxes(bytes, 'traf')) {
    const tfhd = findBox(bytes, 'tfhd', traf.dataStart, traf.end);
    if (!tfhd) continue;
    const id = bytes.readUInt32BE(tfhd.dataStart + 4);
    for (const trun of findBoxes(bytes, 'trun', traf.dataStart, traf.end)) {
      counts.set(id, (counts.get(id) ?? 0) + bytes.readUInt32BE(trun.dataStart + 4));
    }
  }
  return counts;
}

/** The sound track, if there is one. */
export function audioTrack(file: Mp4): Mp4Track | null {
  return file.tracks.find((track) => track.kind === 'soun') ?? null;
}

export function readMp4(bytes: Buffer): Mp4 {
  const ftyp = findBox(bytes, 'ftyp');
  const brand = ftyp ? bytes.subarray(ftyp.dataStart, ftyp.dataStart + 4).toString('latin1') : '';

  const mvhd = findBox(bytes, 'mvhd');
  let seconds = 0;
  if (mvhd) {
    const version = bytes[mvhd.dataStart];
    if (version === 1) {
      const timescale = bytes.readUInt32BE(mvhd.dataStart + 20);
      const duration = Number(bytes.readBigUInt64BE(mvhd.dataStart + 24));
      seconds = timescale ? duration / timescale : 0;
    } else {
      const timescale = bytes.readUInt32BE(mvhd.dataStart + 12);
      const duration = bytes.readUInt32BE(mvhd.dataStart + 16);
      seconds = timescale ? duration / timescale : 0;
    }
  }

  const tracks: Mp4Track[] = [];
  for (const trak of findBoxes(bytes, 'trak')) {
    const track = readTrack(bytes, trak);
    if (track) tracks.push(track);
  }

  // A file with movie fragments states its duration in the fragments rather
  // than in mvhd, which is why a zero there is not necessarily a bug - and
  // its samples too, so a track that declared none is counted from them.
  const fragmented = findBoxes(bytes, 'moof').length > 0;
  if (fragmented) {
    const counts = fragmentedSamples(bytes);
    for (const track of tracks) {
      if (track.samples === 0) track.samples = counts.get(track.id) ?? 0;
    }
  }

  return { brand, seconds, tracks, fragmented };
}

/** Whether these bytes look like an MP4 at all. */
export function isMp4(bytes: Buffer): boolean {
  return bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** The video track, if there is one. */
export function videoTrack(file: Mp4): Mp4Track | null {
  return file.tracks.find((track) => track.kind === 'vide') ?? null;
}
