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
