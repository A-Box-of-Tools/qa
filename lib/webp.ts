/**
 * A WebP reader and a small WebP writer, so the converters can be handed a
 * file whose every pixel is known and have their output opened by something
 * other than themselves.
 *
 * THE READER is the part the PNG-to-WebP spec rests on. That tool's one claim
 * is "lossless", and a canvas has no flag for it: Chromium switches codings at
 * quality 1.0 exactly, the page reads its own output back to see which coding
 * came out, and the row says so. Which chunk the pixels are in - `VP8L` for the
 * lossless coding, `VP8 ` for the lossy one - is a fact about the bytes, so it
 * is read here, from the bytes, by a walk that shares nothing with the site's.
 *
 * THE WRITER exists because the other direction needs a WebP to start from,
 * and the engines this suite runs on do not all write one. It is the lossless
 * coding with nothing clever in it: no transforms, no colour cache, no
 * backward references, and each channel's prefix code is the "simple" kind the
 * format allows for an alphabet of one or two symbols. That is the whole
 * restriction - a channel may take at most two values across the picture - and
 * it is the right one for a fixture, which wants flat regions of known colour
 * rather than a photograph. A channel with one value costs no bits at all; a
 * channel with two costs one bit a pixel.
 *
 * It also writes the container around an animation, which is only container
 * work: each frame is one of those stills inside an `ANMF` chunk.
 */

export type Rgba = readonly [number, number, number, number];

export interface RiffChunk {
  type: string;
  /** Where the payload starts, in the buffer that was walked. */
  at: number;
  size: number;
}

const ascii = (bytes: Buffer, at: number, length = 4): string => (
  bytes.subarray(at, at + length).toString('latin1')
);

/** Walk a run of RIFF chunks between two offsets. */
function walk(bytes: Buffer, from: number, to: number): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = bytes.readUInt32LE(at + 4);
    chunks.push({ type: ascii(bytes, at), at: at + 8, size });
    // Padded to an even length, and the pad byte is not counted in the size.
    at += 8 + size + (size & 1);
  }
  return chunks;
}

/** The top-level chunks of a WebP, or nothing if it is not one. */
export function webpChunks(bytes: Buffer): RiffChunk[] {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP') return [];
  return walk(bytes, 12, bytes.length);
}

export interface WebpFacts {
  /** Every chunk type in file order, an animation's frames opened up. */
  chunks: string[];
  /** The coding the pixels are in: 'VP8L' lossless, 'VP8 ' lossy. */
  coding: 'VP8L' | 'VP8 ' | null;
  /** How many `ANMF` frames; zero for a still. */
  frames: number;
  /** The extended header says there is alpha somewhere in the file. */
  alphaFlag: boolean;
  width: number;
  height: number;
}

/** What a WebP is, read from its chunks and headers without decoding a pixel. */
export function webpFacts(bytes: Buffer): WebpFacts {
  const top = webpChunks(bytes);
  const all: RiffChunk[] = [];
  for (const chunk of top) {
    all.push(chunk);
    // A frame's own chunks sit after sixteen bytes of placement and timing.
    if (chunk.type === 'ANMF') all.push(...walk(bytes, chunk.at + 16, chunk.at + chunk.size));
  }

  const pixels = all.find((chunk) => chunk.type === 'VP8L' || chunk.type === 'VP8 ');
  const extended = top[0]?.type === 'VP8X' ? top[0] : null;

  let width = 0;
  let height = 0;
  if (extended) {
    width = bytes.readUIntLE(extended.at + 4, 3) + 1;
    height = bytes.readUIntLE(extended.at + 7, 3) + 1;
  } else if (pixels?.type === 'VP8L') {
    // A signature byte, then fourteen bits each of width and height, less one.
    const packed = bytes.readUInt32LE(pixels.at + 1);
    width = (packed & 0x3fff) + 1;
    height = ((packed >>> 14) & 0x3fff) + 1;
  } else if (pixels) {
    // Lossy: a three-byte frame tag, the start code 9d 01 2a, then the sizes.
    width = bytes.readUInt16LE(pixels.at + 6) & 0x3fff;
    height = bytes.readUInt16LE(pixels.at + 8) & 0x3fff;
  }

  return {
    chunks: all.map((chunk) => chunk.type),
    coding: (pixels?.type as WebpFacts['coding']) ?? null,
    frames: top.filter((chunk) => chunk.type === 'ANMF').length,
    alphaFlag: Boolean(extended && (bytes[extended.at] & 0x10)),
    width,
    height,
  };
}

/* ------------------------------------------------------------------ writing */

/** Bits go in least significant first, which is the order VP8L reads them. */
class BitWriter {
  private readonly bytes: number[] = [];
  private held = 0;
  private count = 0;

  write(value: number, bits: number): void {
    for (let i = 0; i < bits; i += 1) {
      this.held |= ((value >>> i) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.held);
        this.held = 0;
        this.count = 0;
      }
    }
  }

  finish(): Buffer {
    if (this.count > 0) this.bytes.push(this.held);
    return Buffer.from(this.bytes);
  }
}

function riffChunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, Buffer.alloc(payload.length & 1)]);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function uint24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

type Paint = (x: number, y: number) => Rgba;

/** One picture as a `VP8L` chunk, and whether anything in it is see-through. */
function losslessChunk(width: number, height: number, paint: Paint): { chunk: Buffer; alpha: boolean } {
  const pixels: Rgba[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.push(paint(x, y));
  }

  // The order the format codes a pixel in: green, red, blue, alpha.
  const ORDER = [1, 0, 2, 3] as const;
  const alphabets = ORDER.map((channel) => (
    [...new Set(pixels.map((pixel) => pixel[channel]))].sort((a, b) => a - b)
  ));
  for (const [index, values] of alphabets.entries()) {
    if (values.length > 2) {
      throw new Error(
        `channel ${'grba'[index]} takes ${values.length} values; this writer codes at most two`,
      );
    }
  }

  const alpha = pixels.some((pixel) => pixel[3] !== 255);
  const bits = new BitWriter();

  bits.write(0x2f, 8); // signature
  bits.write(width - 1, 14);
  bits.write(height - 1, 14);
  bits.write(alpha ? 1 : 0, 1);
  bits.write(0, 3); // version

  bits.write(0, 1); // no transform
  bits.write(0, 1); // no colour cache
  bits.write(0, 1); // one group of prefix codes for the whole picture

  // A simple prefix code: how many symbols, then each as eight bits. The
  // smaller of two symbols reads as a 0 bit and the larger as a 1, because the
  // codes are assigned in symbol order; a lone symbol is read from no bits.
  const simple = (symbols: number[]): void => {
    bits.write(1, 1);
    bits.write(symbols.length - 1, 1);
    bits.write(1, 1); // the first symbol is given in eight bits rather than one
    for (const symbol of symbols) bits.write(symbol, 8);
  };
  for (const values of alphabets) simple(values);
  simple([0]); // the distance code, which nothing here ever uses

  for (const pixel of pixels) {
    for (const [index, channel] of ORDER.entries()) {
      const values = alphabets[index];
      if (values.length === 2) bits.write(values.indexOf(pixel[channel]), 1);
    }
  }

  return { chunk: riffChunk('VP8L', bits.finish()), alpha };
}

function extendedHeader(width: number, height: number, flags: number): Buffer {
  return riffChunk('VP8X', Buffer.concat([
    Buffer.from([flags, 0, 0, 0]),
    uint24(width - 1),
    uint24(height - 1),
  ]));
}

const ALPHA = 0x10;
const ANIMATION = 0x02;

/**
 * A lossless WebP of known pixels.
 *
 * `extended` decides which of the two legal layouts is written, and the
 * difference is not cosmetic. The extended layout opens with a `VP8X` header
 * carrying a flag that says "there is alpha in here", which is what a reader
 * can see without decoding; the simple layout is the `VP8L` chunk alone, with
 * its alpha declared only inside the bitstream. Encoders write both, so a
 * converter meets both.
 */
export function encodeWebp(
  width: number,
  height: number,
  paint: Paint,
  { extended = true }: { extended?: boolean } = {},
): Buffer {
  const { chunk, alpha } = losslessChunk(width, height, paint);
  if (!extended) return riff([chunk]);
  return riff([extendedHeader(width, height, alpha ? ALPHA : 0), chunk]);
}

/**
 * An animated WebP: each frame a full-canvas lossless still.
 *
 * Every frame replaces the one before it outright (no blending, no disposal
 * to background), so what a frame shows is exactly what its `paint` says.
 */
export function encodeAnimatedWebp(
  width: number,
  height: number,
  frames: { paint: Paint; ms: number }[],
): Buffer {
  const coded = frames.map((frame) => ({ ...losslessChunk(width, height, frame.paint), ms: frame.ms }));
  const alpha = coded.some((frame) => frame.alpha);

  const anim = riffChunk('ANIM', Buffer.concat([
    Buffer.alloc(4), // background colour, which players are free to ignore
    Buffer.from([0, 0]), // loop for ever
  ]));

  const anmf = coded.map((frame) => riffChunk('ANMF', Buffer.concat([
    uint24(0), // x
    uint24(0), // y
    uint24(width - 1),
    uint24(height - 1),
    uint24(frame.ms),
    Buffer.from([0b10]), // do not blend; do not dispose
    frame.chunk,
  ])));

  return riff([
    extendedHeader(width, height, ANIMATION | (alpha ? ALPHA : 0)),
    anim,
    ...anmf,
  ]);
}
