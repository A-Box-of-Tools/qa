import fs from 'node:fs';
import path from 'node:path';

/**
 * The committed AVIFs, and enough of a reader to say what they are.
 *
 * AVIF is the second format here that cannot be generated - see
 * fixtures/README.md - so two small files are committed, and this reads what
 * the tests then hold the converter to: that the file really is an AVIF by its
 * brands, the size it declares, and whether it carries an alpha plane. All
 * three are in the container, which is ISO base media boxes, so none of it
 * needs a decoder and none of it is taken from the browser under test.
 */

const FIXTURES = path.join(__dirname, '..', 'fixtures');

/** Four flat quadrants, opaque. */
export const quadrantsAvif = (): Buffer => fs.readFileSync(path.join(FIXTURES, 'quadrants.avif'));

/** The same picture with its right half fully transparent. */
export const seeThroughAvif = (): Buffer => fs.readFileSync(path.join(FIXTURES, 'see-through.avif'));

export const AVIF_WIDTH = 320;
export const AVIF_HEIGHT = 240;

/**
 * The colour at the middle of each quadrant, as the files were drawn.
 *
 * A lossy codec in 4:2:0 brings these back within a level or two in the
 * middle of a flat region, which is where the tests look; the edges between
 * quadrants are where it would smear, and nothing reads there.
 */
export const QUADRANTS = {
  topLeft: { x: 80, y: 60, rgb: [200, 50, 50] },
  topRight: { x: 240, y: 60, rgb: [50, 160, 60] },
  bottomLeft: { x: 80, y: 180, rgb: [40, 80, 200] },
  bottomRight: { x: 240, y: 180, rgb: [230, 210, 60] },
} as const;

interface Box {
  type: string;
  /** Where the payload starts and ends. */
  from: number;
  to: number;
}

function boxes(bytes: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    let head = 8;
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(at + 8));
      head = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < head) break;
    out.push({ type, from: at + head, to: Math.min(to, at + size) });
    at += size;
  }
  return out;
}

export interface AvifFacts {
  brands: string[];
  /** The size its first image-spatial-extents property declares. */
  width: number;
  height: number;
  /** An auxiliary image is declared to be an alpha plane. */
  alpha: boolean;
}

export function avifFacts(bytes: Buffer): AvifFacts {
  const top = boxes(bytes, 0, bytes.length);

  const ftyp = top.find((box) => box.type === 'ftyp');
  const brands: string[] = [];
  if (ftyp) {
    // The major brand, four bytes of version, then the compatible brands.
    brands.push(bytes.subarray(ftyp.from, ftyp.from + 4).toString('latin1'));
    for (let at = ftyp.from + 8; at + 4 <= ftyp.to; at += 4) {
      brands.push(bytes.subarray(at, at + 4).toString('latin1'));
    }
  }

  // meta is a full box: four bytes of version and flags before its children.
  const meta = top.find((box) => box.type === 'meta');
  const inMeta = meta ? boxes(bytes, meta.from + 4, meta.to) : [];
  const iprp = inMeta.find((box) => box.type === 'iprp');
  const ipco = iprp ? boxes(bytes, iprp.from, iprp.to).find((box) => box.type === 'ipco') : undefined;
  const properties = ipco ? boxes(bytes, ipco.from, ipco.to) : [];

  const ispe = properties.find((box) => box.type === 'ispe');
  const alpha = properties
    .filter((box) => box.type === 'auxC')
    .some((box) => bytes.subarray(box.from, box.to).toString('latin1').includes('auxiliary:alpha'));

  return {
    brands,
    width: ispe ? bytes.readUInt32BE(ispe.from + 4) : 0,
    height: ispe ? bytes.readUInt32BE(ispe.from + 8) : 0,
    alpha,
  };
}
