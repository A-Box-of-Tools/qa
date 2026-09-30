import { expect, type Page } from '@playwright/test';
import { ask, onAPageOfItsOwn } from './engine';

/**
 * These converters need the H.264 WebCodecs path, not merely MediaRecorder.
 * Ask independently on a disposable page because some WebKit builds expose
 * VideoEncoder but crash when its codec support is queried.
 */
export async function canEncodeH264(page: Page): Promise<boolean> {
  return ask(page, 'encode-h264-webcodecs', () => onAPageOfItsOwn(page, (own) => own.evaluate(async () => {
    const platform = globalThis as {
      VideoEncoder?: { isConfigSupported(config: unknown): Promise<{ supported?: boolean }> };
      VideoFrame?: unknown;
    };
    const encoder = platform.VideoEncoder;
    if (!encoder?.isConfigSupported || typeof platform.VideoFrame !== 'function') return false;
    // The same profiles and complete configuration that the converter may use,
    // without consulting the tool's own result or importing its implementation.
    const profiles = [
      'avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002a', 'avc1.640028',
      'avc1.4d0034', 'avc1.4d0028', 'avc1.42003e', 'avc1.42001f',
    ];
    for (const codec of profiles) {
      try {
        const supported = await Promise.race([
          encoder.isConfigSupported({
            codec, width: 320, height: 240, framerate: 30,
            bitrate: 1_200_000, avc: { format: 'avc' },
          }),
          new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 2_000); }),
        ]);
        if (!supported) return false;
        if (supported.supported) return true;
      } catch { /* another profile may still be supported */ }
    }
    return false;
  })), false);
}

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
