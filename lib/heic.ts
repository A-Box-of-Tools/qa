import fs from 'node:fs';
import path from 'node:path';

/**
 * The one checked-in binary fixture, and enough HEIC reading to say what is
 * supposed to come out of it.
 *
 * Every other fixture in this suite is generated - PNG, GIF, PDF, WAV and MP4
 * are all written by lib/ or recorded by the browser. HEIC is the exception
 * and has to be: the picture inside one is an HEVC frame, and as the tool's
 * own README puts it, every browser will decode HEVC inside a <video> and
 * refuse to decode it as a still. There is no way to make one here, so a real
 * photograph is committed instead.
 *
 * WHERE IT CAME FROM
 *
 * chef-with-trumpet.heic is a sample published for testing at
 * https://heic.digital/samples/ - not a photograph of anybody's, and not
 * something generated here. It is recorded because it is the only file in
 * this repository that was not written by it, and a reader should not have to
 * guess where a committed binary came from. See fixtures/README.md.
 *
 * WHAT MAKES IT A GOOD FIXTURE
 *
 * It is 4032 x 3024 and stored the way Apple stores photographs: as a grid of
 * 512 x 512 tiles. That is what it tests. A converter that decoded the first
 * tile and stopped would produce a 512 x 512 picture that opens perfectly
 * well, and only the dimensions give it away.
 *
 * Its EXIF says Apple, iPad Air (5th generation), iOS 15.6.1, and a capture
 * time in November 2022; there is no GPS in it. The metadata is the point
 * rather than an oversight: this tool can be asked to keep it or drop it, and
 * both directions need checking.
 */

export const HEIC_FIXTURE = path.join(__dirname, '..', 'fixtures', 'chef-with-trumpet.heic');

/** The photograph's real size, read from its ispe box rather than assumed. */
export const HEIC_WIDTH = 4032;
export const HEIC_HEIGHT = 3024;

export function heicBytes(): Buffer {
  return fs.readFileSync(HEIC_FIXTURE);
}

/**
 * Every image size declared in a HEIC, largest last.
 *
 * `ispe` (image spatial extents) is a fixed shape - the box name, four bytes
 * of version and flags, then width and height - so finding the boxes is
 * enough; there is no need to walk the whole meta structure to answer "how big
 * is the picture in here".
 */
export function declaredSizes(bytes: Buffer): Array<{ width: number; height: number }> {
  const out: Array<{ width: number; height: number }> = [];
  let at = 0;

  for (;;) {
    const found = bytes.indexOf(Buffer.from('ispe', 'latin1'), at);
    if (found < 0 || found + 16 > bytes.length) break;
    out.push({
      width: bytes.readUInt32BE(found + 8),
      height: bytes.readUInt32BE(found + 12),
    });
    at = found + 4;
  }

  return out.sort((a, b) => a.width * a.height - b.width * b.height);
}

/** The largest picture the file declares - the one a converter should produce. */
export function fullSize(bytes: Buffer): { width: number; height: number } {
  const sizes = declaredSizes(bytes);
  if (sizes.length === 0) throw new Error('this HEIC declares no image size');
  return sizes[sizes.length - 1];
}
