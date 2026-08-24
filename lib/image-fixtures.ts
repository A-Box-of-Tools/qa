import zlib from 'node:zlib';

/**
 * A minimal PNG encoder, so tests can hand a tool a picture whose every pixel
 * is known and then check the pixels that come back.
 *
 * PNG rather than JPEG on purpose: the point of these fixtures is exact
 * comparison, and a lossy codec turns "is this pixel still red" into a
 * question about thresholds. Written here rather than pulled from npm because
 * it is forty lines and this repository has no runtime dependencies.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

export type Rgb = readonly [number, number, number];

/** An opaque 8-bit RGBA PNG, each pixel decided by `paint`. */
export function encodePng(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgb,
): Buffer {
  // One filter byte (0 - none) then RGBA, per scanline.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let at = 0;

  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = 255;
      at += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rectangle in pixels, the shape both the fixtures and the tool talk in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const inside = (rect: Rect, x: number, y: number): boolean => (
  x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
);

/**
 * A picture built for testing a redactor: a flat background, one block of a
 * colour that appears nowhere else (the thing that must not survive), and one
 * block of a third colour well away from it (the thing that must survive
 * untouched).
 *
 * The secret block is drawn as one-pixel vertical stripes rather than a solid
 * patch, and that detail matters. A mosaic replaces each block with that
 * block's average, so pixelating a *solid* patch reproduces the patch's colour
 * exactly - which would make "the secret colour is gone" pass for a black fill
 * and fail for a mosaic without either result saying anything about how much
 * was destroyed. Stripes give the region real detail to lose, so a mosaic can
 * be checked for having flattened it.
 */
export function redactionFixture(
  width: number,
  height: number,
  secret: Rect,
  keep: Rect,
  colours: { background: Rgb; secret: Rgb; keep: Rgb },
): Buffer {
  const white: Rgb = [255, 255, 255];
  return encodePng(width, height, (x, y) => {
    if (inside(secret, x, y)) return x % 2 === 0 ? colours.secret : white;
    if (inside(keep, x, y)) return colours.keep;
    return colours.background;
  });
}
