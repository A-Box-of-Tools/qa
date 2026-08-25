/**
 * Writing and reading WAV, for the two sound tools.
 *
 * Both of them write WAV because, as edit-audio's README puts it, no browser
 * ships an encoder that could write anything else. That is convenient here:
 * WAV is a header and raw samples, so a fixture can be built with known
 * content and the result read back exactly, with no codec in between to blur
 * the comparison.
 */

export interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Sample frames per channel. */
  frames: number;
  seconds: number;
  /** Channel 0, normalised to -1..1. */
  samples: Float32Array;
}

/** A 16-bit PCM WAV from samples in -1..1. */
export function writeWav(samples: Float32Array, sampleRate = 44_100, channels = 1): Buffer {
  const frames = Math.floor(samples.length / channels);
  const dataBytes = frames * channels * 2;

  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'latin1');

  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);

  out.write('data', 36, 'latin1');
  out.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames * channels; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return out;
}

/**
 * Read a WAV's format and its first channel.
 *
 * Walks the chunk list rather than assuming the data begins at byte 44: a
 * browser-written WAV often carries a `LIST` or `fact` chunk first, and a
 * reader that trusts the classic offset gets silence or noise.
 */
export function readWav(bytes: Buffer): Wav {
  if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF'
    || bytes.subarray(8, 12).toString('latin1') !== 'WAVE') {
    throw new Error('not a WAV file');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = 1;
  let data: Buffer | null = null;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.subarray(at, at + 4).toString('latin1');
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.length));

    if (id === 'fmt ') {
      format = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bitsPerSample = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }

    at += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (!data || !channels || !sampleRate) throw new Error('this WAV has no sound in it');

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const samples = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    const at2 = frame * bytesPerSample * channels; // channel 0
    if (bitsPerSample === 16) {
      samples[frame] = data.readInt16LE(at2) / 32768;
    } else if (bitsPerSample === 32 && format === 3) {
      samples[frame] = data.readFloatLE(at2);
    } else if (bitsPerSample === 32) {
      samples[frame] = data.readInt32LE(at2) / 2147483648;
    } else if (bitsPerSample === 8) {
      samples[frame] = (data[at2] - 128) / 128;
    }
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames,
    seconds: frames / sampleRate,
    samples,
  };
}

/** The loudest absolute sample in a stretch, given as a fraction of `frames`. */
export function peakBetween(wav: Wav, from = 0, to = 1): number {
  const start = Math.floor(wav.frames * from);
  const end = Math.floor(wav.frames * to);
  let peak = 0;
  for (let i = start; i < end; i += 1) {
    const value = Math.abs(wav.samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * A recording that is loud in its first half and quiet in its second.
 *
 * The asymmetry is the point: played backwards it becomes quiet then loud, so
 * "was this reversed" is answerable from the samples rather than by listening.
 */
export function loudThenQuiet(
  seconds = 3,
  sampleRate = 44_100,
  frequency = 440,
): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Float32Array(frames);

  for (let i = 0; i < frames; i += 1) {
    const amplitude = i < frames / 2 ? 0.9 : 0.08;
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }

  return writeWav(samples, sampleRate, 1);
}
