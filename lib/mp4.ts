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
}

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
  if (mdhd) {
    const mdhdVersion = bytes[mdhd.dataStart];
    if (mdhdVersion === 1) {
      const timescale = bytes.readUInt32BE(mdhd.dataStart + 20);
      const duration = Number(bytes.readBigUInt64BE(mdhd.dataStart + 24));
      seconds = timescale ? duration / timescale : 0;
    } else {
      const timescale = bytes.readUInt32BE(mdhd.dataStart + 12);
      const duration = bytes.readUInt32BE(mdhd.dataStart + 16);
      seconds = timescale ? duration / timescale : 0;
    }
  }

  void version;
  return { kind, width, height, seconds };
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

  return {
    brand,
    seconds,
    tracks,
    // A file with movie fragments states its duration in the fragments rather
    // than in mvhd, which is why a zero there is not necessarily a bug.
    fragmented: findBoxes(bytes, 'moof').length > 0,
  };
}

/** Whether these bytes look like an MP4 at all. */
export function isMp4(bytes: Buffer): boolean {
  return bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** The video track, if there is one. */
export function videoTrack(file: Mp4): Mp4Track | null {
  return file.tracks.find((track) => track.kind === 'vide') ?? null;
}
