import type { Page } from '@playwright/test';

/**
 * The pixel size a browser actually decodes a file to.
 *
 * Format-agnostic on purpose: these tools emit PNG, JPEG and WebP from the
 * same controls, and reading each container's own header would mean three
 * parsers and a fourth when a tool gains a format. Decoding is also the
 * stronger check - a file whose header claims 200 x 230 but which no decoder
 * will open is not a file that passes a passport office's web form.
 *
 * Returns zeros and the error when the bytes do not decode, so a test can say
 * "this did not come out as an image" rather than time out.
 */
export async function decodedSize(
  page: Page,
  bytes: Buffer,
  mime = 'image/png',
): Promise<{ width: number; height: number; error?: string }> {
  return page.evaluate(async ({ base64, mime }) => {
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) array[i] = binary.charCodeAt(i);

    try {
      const bitmap = await createImageBitmap(new Blob([array], { type: mime }));
      return { width: bitmap.width, height: bitmap.height };
    } catch (error) {
      return { width: 0, height: 0, error: String(error) };
    }
  }, { base64: bytes.toString('base64'), mime });
}

export interface Decoded {
  width: number;
  height: number;
  /** RGBA, four bytes a pixel, row by row - empty when the bytes did not decode. */
  rgba: Buffer;
  error?: string;
}

/**
 * Every pixel a browser decodes a file to.
 *
 * For the tools whose claim is about the pixels rather than the container: a
 * converter that says "lossless" is saying these numbers are the ones that
 * went in, and a converter that flattens transparency is saying what colour
 * the see-through parts became. Neither can be read off a header.
 *
 * Drawn on a canvas whose own alpha is kept, so a picture with see-through
 * parts reads back with them. A canvas holds colour multiplied by alpha, so
 * the colour under a pixel that is partly transparent does not come back
 * exactly - which is the browser's arithmetic and not the file's. A solid
 * pixel, and the alpha of any pixel, do.
 *
 * Meant for fixtures, which are small. The whole picture crosses from the
 * page to Node as base64, and a photograph would be tens of megabytes of it.
 */
export async function decodedPixels(
  page: Page,
  bytes: Buffer,
  mime = 'image/png',
): Promise<Decoded> {
  const out = await page.evaluate(async ({ base64, mime }) => {
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) array[i] = binary.charCodeAt(i);

    try {
      const bitmap = await createImageBitmap(new Blob([array], { type: mime }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

      let text = '';
      for (let at = 0; at < data.length; at += 0x8000) {
        text += String.fromCharCode(...data.subarray(at, at + 0x8000));
      }
      return { width: bitmap.width, height: bitmap.height, rgba: btoa(text) };
    } catch (error) {
      return { width: 0, height: 0, rgba: '', error: String(error) };
    }
  }, { base64: bytes.toString('base64'), mime });

  return { ...out, rgba: Buffer.from(out.rgba, 'base64') };
}

/** One pixel out of decodedPixels(), as [r, g, b, a]. */
export function pixelAt(decoded: Decoded, x: number, y: number): [number, number, number, number] {
  const at = ((y * decoded.width) + x) * 4;
  return [decoded.rgba[at], decoded.rgba[at + 1], decoded.rgba[at + 2], decoded.rgba[at + 3]];
}
