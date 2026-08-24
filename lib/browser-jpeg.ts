import type { Page } from '@playwright/test';

/**
 * A real, decodable JPEG, encoded by the browser under test.
 *
 * Encoding one in Node would mean writing a DCT and a Huffman coder; the page
 * already has both. Shared between the specs that need genuine photograph
 * bytes rather than a synthetic container - the EXIF remover, which has to
 * prove the scan survived untouched, and the PDF tools, which have to prove a
 * JPEG was carried through without being decoded and compressed again.
 *
 * `seed` varies the drawing, so two fixtures in one test are different files
 * rather than two copies of the same bytes.
 */
export async function realJpeg(
  page: Page,
  width = 240,
  height = 160,
  seed = 0,
): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ width, height, seed }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;

    // Detail rather than a flat fill: a JPEG of a plain rectangle compresses
    // to almost nothing, which makes size comparisons meaningless.
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, seed % 2 ? '#802040' : '#204080');
    gradient.addColorStop(1, seed % 2 ? '#20a080' : '#d0a020');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    for (let i = 0; i < 40; i += 1) {
      context.fillStyle = `hsl(${(i * 37 + seed * 61) % 360} 70% ${30 + (i % 5) * 12}%)`;
      context.fillRect(
        (i * 29 + seed * 7) % width,
        (i * 53 + seed * 11) % height,
        12 + (i % 4) * 6,
        9 + (i % 3) * 7,
      );
    }

    const blob: Blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.92);
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { width, height, seed });

  return Buffer.from(base64, 'base64');
}

/**
 * A JPEG that is genuinely large in bytes, for testing anything with a size
 * target.
 *
 * realJpeg draws flat shapes on a gradient, which JPEG compresses extremely
 * well: 1600 x 1200 of it comes out around 40 KB, already under any target
 * worth asking for, and a compressor handed one has nothing to do. That is
 * correct behaviour and a useless fixture - it makes "compressed" and
 * "untouched" the same file.
 *
 * Per-pixel noise is the opposite case. It defeats the DCT almost entirely, so
 * the encoder has to spend real bytes, and a megabyte or two comes out of a
 * picture this size. The noise is generated from `seed` rather than
 * Math.random so two runs get the same file.
 */
export async function noisyJpeg(
  page: Page,
  width = 1600,
  height = 1200,
  seed = 1,
): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ width, height, seed }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;

    const image = context.createImageData(width, height);
    // A small xorshift, so the picture is noisy but reproducible.
    let state = (seed * 2654435761) >>> 0 || 1;
    for (let at = 0; at < image.data.length; at += 4) {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      image.data[at] = state & 0xff;
      image.data[at + 1] = (state >> 8) & 0xff;
      image.data[at + 2] = (state >> 16) & 0xff;
      image.data[at + 3] = 255;
    }
    context.putImageData(image, 0, 0);

    const blob: Blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95);
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000; // avoid blowing the argument limit on a big file
    for (let at = 0; at < bytes.length; at += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
    }
    return btoa(binary);
  }, { width, height, seed });

  return Buffer.from(base64, 'base64');
}
