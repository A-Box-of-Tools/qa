import { expect, type Page } from '@playwright/test';

/**
 * Hold the next real encoder flush after its bytes have been produced.
 * The decoder and encoder stay real; only delivery of their completion is
 * delayed, so cancellation is checked at the boundary a fast clip hides.
 */
export async function holdVideoFlush(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as any;
    const prototype = state.VideoEncoder.prototype;
    const original = prototype.flush;
    state.__qaExportHeld = false;
    prototype.flush = async function () {
      prototype.flush = original;
      await original.call(this);
      await new Promise<void>((resolve) => {
        state.__qaReleaseExport = resolve;
        state.__qaExportHeld = true;
      });
    };
  });
}

/**
 * Hold the first read of the final output check. This comes after every encode
 * pass, including a compressor's retune, so late Cancel cannot pass merely
 * because it happened to stop a second encode before it began.
 */
export async function holdVerificationRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as any;
    const original = Blob.prototype.slice;
    state.__qaExportHeld = false;
    Blob.prototype.slice = function (start, end, contentType) {
      const part = original.call(this, start, end, contentType);
      if (this instanceof File && this.name === 'check.mp4') {
        Blob.prototype.slice = original;
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => {
          const bytes = await read();
          await new Promise<void>((resolve) => {
            state.__qaReleaseExport = resolve;
            state.__qaExportHeld = true;
          });
          return bytes;
        };
      }
      return part;
    };
  });
}

export async function waitForHeldExport(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__qaExportHeld)),
    { timeout: 240_000 }).toBe(true);
}

export async function releaseHeldExport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as any;
    state.__qaReleaseExport();
    delete state.__qaReleaseExport;
    state.__qaExportHeld = false;
  });
}
