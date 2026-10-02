import type { Page } from '@playwright/test';

/**
 * Decode saved bytes in a fresh native player, independently of every tool's
 * preview. The default median ignores the fixture's narrow moving black bar;
 * average mode preserves the whole-frame oracle used by the other video tests.
 * Both wait for the same settled presentation before reading any pixels.
 */
export async function sampleVideoFrames(
  page: Page,
  bytes: Buffer,
  times: number[],
  options: { average?: boolean; clamp?: boolean } = {},
) {
  return page.evaluate(async ({ data, times, options }) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // A detached player's seeked event can precede the picture available to
    // canvas. Keep this independent source oracle paintable like the output.
    video.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:240px;z-index:2147483647;pointer-events:none';
    document.body.append(video);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    let callback = 0;
    let animation = 0;
    const picture = (mediaTime: number) => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
        throw new Error('the source video presented no readable picture');
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      let colour: number[];
      if (options.average) {
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let r = 0; let g = 0; let b = 0; let count = 0;
        for (let at = 0; at < data.length; at += 4) {
          // Exclude the fixture's moving black bar without changing the
          // original whole-frame average or accepting an unreadable picture.
          if (data[at] + data[at + 1] + data[at + 2] < 90) continue;
          r += data[at]; g += data[at + 1]; b += data[at + 2];
          count += 1;
        }
        if (!count) throw new Error(`no colored pixels in a presented fixture frame: ${JSON.stringify({
          mediaTime, clock: video.currentTime, duration: video.duration,
          readyState: video.readyState, width: canvas.width, height: canvas.height,
        })}`);
        colour = [r / count, g / count, b / count];
      } else {
        const pixels = [0.15, 0.5, 0.85].map((x) => context.getImageData(
          Math.floor(x * canvas.width), Math.floor(canvas.height / 4), 1, 1,
        ).data);
        colour = [0, 1, 2].map((channel) =>
          pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b)[1]);
      }
      return { mediaTime, clock: video.currentTime, colour };
    };
    const presented = (start: () => void, target?: number) => new Promise<ReturnType<typeof picture>>((resolve, reject) => {
      let settled = target === undefined;
      let completed = false;
      let frame: ReturnType<typeof picture> | undefined;
      let presentation: number | undefined;
      let painting = false;
      let pausedForSample = false;
      let lastPresentation: {
        mediaTime: number; clock: number; seeking: boolean;
        readyState: number; width: number; height: number;
      } | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        if (hasFrameCallback) video.cancelVideoFrameCallback(callback);
        cancelAnimationFrame(animation);
        video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('seeked', seeked);
        video.removeEventListener('error', failed);
      };
      const fail = (error: unknown) => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(error);
      };
      const finish = () => {
        if (completed || presentation === undefined || !settled || painting) return;
        painting = true;
        const mediaTime = presentation;
        let paints = 0;
        // Chromium may report the seek's only presentation while readiness
        // still says HAVE_METADATA. Retain that signal, then wait for seeked
        // and two paints before reading the picture available to canvas.
        const afterPaint = () => {
          if (completed) return;
          if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
              || !video.videoWidth || !video.videoHeight) {
            paints = 0;
          } else if (++paints >= 2) {
            if (target !== undefined && Math.abs(video.currentTime - target) > 0.0001) {
              fail(new Error(`source seek did not reach ${target}s: clock ${video.currentTime}s`));
              return;
            }
            try { frame = picture(mediaTime); }
            catch (error) { fail(error); return; }
            completed = true;
            cleanup();
            resolve(frame);
            return;
          }
          animation = requestAnimationFrame(afterPaint);
        };
        animation = requestAnimationFrame(afterPaint);
      };
      const paint = (mediaTime: number) => {
        if (completed) return;
        lastPresentation = {
          mediaTime, clock: video.currentTime, seeking: video.seeking,
          readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
        };
        presentation = mediaTime;
        if (target === undefined) {
          pausedForSample = true;
          video.pause();
        }
        finish();
      };
      // Older engines cannot identify presented frames. After their native
      // load/seek event, allow two paint opportunities before reading canvas.
      const fallback = () => {
        if (completed) return;
        animation = requestAnimationFrame(() => {
          if (completed) return;
          animation = requestAnimationFrame(() => paint(video.currentTime));
        });
      };
      const arm = () => {
        callback = video.requestVideoFrameCallback((_now, metadata) => paint(metadata.mediaTime));
      };
      const loaded = () => {
        if (target !== undefined || completed) return;
        if (!hasFrameCallback) { fallback(); return; }
        // A paused, loaded player can show its poster without firing rVFC.
        // Start muted playback to obtain a real presentation, then pause in
        // paint(). A late play rejection must not cancel the following seek.
        arm();
        void video.play().catch((error) => {
          // Pausing on the first callback can interrupt play() before its
          // promise settles. That intentional stop still has a picture.
          if (pausedForSample && error?.name === 'AbortError') return;
          fail(error);
        });
      };
      const seeked = () => {
        if (completed) return;
        settled = true;
        if (!hasFrameCallback) fallback();
        else finish();
      };
      const failed = () => fail(new Error(`source video failed with native error ${video.error?.code}`));
      const timer = setTimeout(() => fail(new Error(`source presented frame did not arrive within 15s: ${JSON.stringify({
        target, clock: video.currentTime, seeking: video.seeking, readyState: video.readyState, frame, presentation, lastPresentation,
      })}`)), 15_000);
      video.addEventListener('loadeddata', loaded);
      video.addEventListener('seeked', seeked);
      video.addEventListener('error', failed);
      if (hasFrameCallback && target !== undefined) arm();
      try { start(); }
      catch (error) { fail(error); }
    });
    try {
      // Brief playback presents the initial picture before any seek callback
      // is armed; a poster cannot satisfy the first requested source time.
      let previous = await presented(() => { video.src = url; });
      const frames: Array<ReturnType<typeof picture>> = [];
      for (const requestedTime of times) {
        if (!Number.isFinite(requestedTime)) {
          throw new Error('a requested source frame is outside the downloaded video');
        }
        const time = options.clamp
          ? Math.min(Math.max(0, requestedTime), Math.max(0, video.duration - 0.05))
          : requestedTime;
        if (time < 0 || time >= video.duration) {
          throw new Error('a requested source frame is outside the downloaded video');
        }
        if (video.currentTime !== time) previous = await presented(() => { video.currentTime = time; }, time);
        frames.push(previous);
      }
      return {
        duration: video.duration, width: video.videoWidth, height: video.videoHeight,
        colours: frames.map(({ colour }) => colour), presentedTimes: frames.map(({ mediaTime }) => mediaTime),
        sampledTimes: frames.map(({ clock }) => clock),
      };
    } finally {
      if (hasFrameCallback) video.cancelVideoFrameCallback(callback);
      cancelAnimationFrame(animation);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, { data: Array.from(bytes), times, options });
}
