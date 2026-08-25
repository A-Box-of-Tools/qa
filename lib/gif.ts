/**
 * Reading and writing GIFs, so the three GIF tools can be checked against
 * something none of them wrote.
 *
 * Each of gif-maker, split-gif and gif-analyzer ships its own gif.js, and two
 * of them their own lzw.js. Using any of those as the oracle would mean
 * testing a tool against a copy of itself, so this is a separate
 * implementation: the parser walks the block structure without decoding pixel
 * data (frame count, sizes, delays and loop count all live in the headers),
 * and the writer does real LZW, because a fixture that only some decoders
 * accept would fail tests for the wrong reason.
 */

/* ------------------------------------------------------------------ reading */

export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Milliseconds. GIF stores hundredths of a second. */
  delayMs: number;
  /** 0 none, 1 keep, 2 restore background, 3 restore previous. */
  disposal: number;
  transparentIndex: number | null;
  localPalette: boolean;
}

export interface Gif {
  version: string;
  width: number;
  height: number;
  globalPalette: number;
  /** From the NETSCAPE application extension; 0 means forever, null means absent. */
  loopCount: number | null;
  frames: GifFrame[];
}

/** Walk the sub-block chain starting at `at`, returning the offset just past it. */
function skipSubBlocks(bytes: Buffer, at: number): number {
  while (at < bytes.length) {
    const size = bytes[at];
    at += 1;
    if (size === 0) return at;
    at += size;
  }
  return at;
}

/** Collect the sub-block payload starting at `at`. */
function readSubBlocks(bytes: Buffer, at: number): { data: Buffer; next: number } {
  const parts: Buffer[] = [];
  while (at < bytes.length) {
    const size = bytes[at];
    at += 1;
    if (size === 0) break;
    parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  return { data: Buffer.concat(parts), next: at };
}

export function readGif(bytes: Buffer): Gif {
  const signature = bytes.subarray(0, 6).toString('latin1');
  if (!signature.startsWith('GIF')) {
    throw new Error(`not a GIF: it starts ${JSON.stringify(signature)}`);
  }

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10];

  let at = 13;
  let globalPalette = 0;
  if (packed & 0x80) {
    globalPalette = 2 ** ((packed & 0x07) + 1);
    at += globalPalette * 3;
  }

  const frames: GifFrame[] = [];
  let loopCount: number | null = null;

  // Carried from the most recent graphic control extension onto the next image.
  let pendingDelay = 0;
  let pendingDisposal = 0;
  let pendingTransparent: number | null = null;

  while (at < bytes.length) {
    const marker = bytes[at];

    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) { // extension
      const label = bytes[at + 1];
      at += 2;

      if (label === 0xf9) { // graphic control
        // `at` is the block-size byte, which is also the first sub-block's
        // size - an extension is just a sub-block chain - so the fields are
        // read relative to it and skipSubBlocks walks the whole chain.
        const flags = bytes[at + 1];
        pendingDisposal = (flags >> 2) & 0x07;
        pendingDelay = bytes.readUInt16LE(at + 2) * 10;
        pendingTransparent = flags & 0x01 ? bytes[at + 4] : null;
        at = skipSubBlocks(bytes, at);
        continue;
      }

      if (label === 0xff) { // application
        const size = bytes[at];
        const name = bytes.subarray(at + 1, at + 1 + size).toString('latin1');
        const { data, next } = readSubBlocks(bytes, at + 1 + size);
        if (name.startsWith('NETSCAPE') && data.length >= 3 && data[0] === 1) {
          loopCount = data.readUInt16LE(1);
        }
        at = next;
        continue;
      }

      at = skipSubBlocks(bytes, at); // any other extension: just a sub-block chain
      continue;
    }

    if (marker === 0x2c) { // image descriptor
      const left = bytes.readUInt16LE(at + 1);
      const top = bytes.readUInt16LE(at + 3);
      const frameWidth = bytes.readUInt16LE(at + 5);
      const frameHeight = bytes.readUInt16LE(at + 7);
      const framePacked = bytes[at + 9];
      at += 10;

      const localPalette = Boolean(framePacked & 0x80);
      if (localPalette) at += 2 ** ((framePacked & 0x07) + 1) * 3;

      at += 1; // minimum LZW code size
      at = skipSubBlocks(bytes, at);

      frames.push({
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        delayMs: pendingDelay,
        disposal: pendingDisposal,
        transparentIndex: pendingTransparent,
        localPalette,
      });

      pendingDelay = 0;
      pendingDisposal = 0;
      pendingTransparent = null;
      continue;
    }

    // Anything else means the walk has lost its place; stopping is better than
    // inventing frames out of misread bytes.
    break;
  }

  return {
    version: signature,
    width,
    height,
    globalPalette,
    loopCount,
    frames,
  };
}

/* ------------------------------------------------------------------ writing */

/** LZW as GIF wants it: LSB-first codes, a growing code width, packed into sub-blocks. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let dictionary = new Map<string, number>();

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const character = indices[i];
    const key = `${prefix},${character}`;
    const found = dictionary.get(key);

    if (found !== undefined) {
      prefix = found;
      continue;
    }

    emit(prefix);
    dictionary.set(key, next);
    next += 1;

    if (next > (1 << codeSize) && codeSize < 12) {
      codeSize += 1;
    } else if (next >= 4096) {
      emit(clearCode);
      dictionary = new Map();
      codeSize = minCodeSize + 1;
      next = endCode + 1;
    }

    prefix = character;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);

  // Into sub-blocks of at most 255 bytes, terminated by an empty one.
  const packed: number[] = [];
  for (let at = 0; at < out.length; at += 255) {
    const chunk = out.slice(at, at + 255);
    packed.push(chunk.length, ...chunk);
  }
  packed.push(0);

  return Buffer.from(packed);
}

export interface FixtureGifFrame {
  /** One palette index per pixel, row by row. */
  indices: Uint8Array;
  /** Milliseconds; GIF rounds to hundredths of a second. */
  delayMs: number;
}

/**
 * An animated GIF with a global palette and one image per frame.
 *
 * Deliberately plain - no local palettes, no interlacing, no frame offsets -
 * so a tool that mishandles it is mishandling the ordinary case.
 */
export function writeGif(
  width: number,
  height: number,
  palette: Array<[number, number, number]>,
  frames: FixtureGifFrame[],
  loopCount = 0,
): Buffer {
  if (frames.length === 0) throw new Error('a GIF needs at least one frame');

  // A GIF palette is a power of two, at least two entries.
  let bits = 1;
  while (2 ** bits < palette.length) bits += 1;
  const paletteSize = 2 ** bits;

  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80 | (bits - 1); // global table present, of this size
  header[11] = 0;
  header[12] = 0;

  const table = Buffer.alloc(paletteSize * 3);
  palette.forEach(([r, g, b], index) => {
    table[index * 3] = r;
    table[index * 3 + 1] = g;
    table[index * 3 + 2] = b;
  });

  const parts: Buffer[] = [header, table];

  // The NETSCAPE extension, which is the only way a GIF says it loops.
  const netscape = Buffer.alloc(19);
  netscape[0] = 0x21;
  netscape[1] = 0xff;
  netscape[2] = 11;
  netscape.write('NETSCAPE2.0', 3, 'latin1');
  netscape[14] = 3;
  netscape[15] = 1;
  netscape.writeUInt16LE(loopCount, 16);
  netscape[18] = 0;
  parts.push(netscape);

  const minCodeSize = Math.max(2, bits);

  for (const frame of frames) {
    const control = Buffer.alloc(8);
    control[0] = 0x21;
    control[1] = 0xf9;
    control[2] = 4;
    control[3] = 0; // no transparency, no disposal
    control.writeUInt16LE(Math.round(frame.delayMs / 10), 4);
    control[6] = 0;
    control[7] = 0;
    parts.push(control);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0; // no local table, not interlaced
    parts.push(descriptor);

    parts.push(Buffer.from([minCodeSize]));
    parts.push(lzwEncode(frame.indices, minCodeSize));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/**
 * A simple animation: `count` frames, each a solid block of a different
 * palette entry with a moving bar, so the frames are visibly distinct and a
 * splitter that emitted the same frame twice would be caught.
 */
export function animationFixture(
  width: number,
  height: number,
  count: number,
  delayMs = 100,
): { bytes: Buffer; palette: Array<[number, number, number]> } {
  const palette: Array<[number, number, number]> = [
    [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];

  const frames: FixtureGifFrame[] = [];
  for (let n = 0; n < count; n += 1) {
    const indices = new Uint8Array(width * height);
    const background = (n % (palette.length - 1)) + 1;
    indices.fill(background);

    // A vertical bar that moves with the frame number.
    const barAt = Math.floor((n / Math.max(1, count)) * width);
    for (let y = 0; y < height; y += 1) {
      for (let x = barAt; x < Math.min(width, barAt + Math.max(1, Math.floor(width / 8))); x += 1) {
        indices[y * width + x] = 0;
      }
    }

    frames.push({ indices, delayMs });
  }

  return { bytes: writeGif(width, height, palette, frames), palette };
}
