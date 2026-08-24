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
