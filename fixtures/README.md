# fixtures

Almost nothing lives here, and that is deliberate.

Every other fixture this suite uses is **generated**: PNG, ICO, GIF, PDF and
WAV are written by the encoders in [`lib/`](../lib), and JPEG, MP4 and WebP are
recorded by the browser under test. Generated fixtures can be shaped to the
test — a picture whose secret region is one-pixel stripes, a recording that is
loud then quiet, an animation whose colour sweeps as it plays — and they cost
the repository nothing to carry.

## The one exception

| File | What it is |
|---|---|
| `chef-with-trumpet.heic` | A 4032 × 3024 HEIC, stored as a grid of 512 × 512 tiles |

HEIC cannot be generated here. The picture inside one is an HEVC frame, and as
[the tool's own README](../../etoolbox/tools/heic-to-jpg/README.md) puts it,
every browser will decode HEVC inside a `<video>` and refuse to decode it as a
still. There is no encoder to reach for and no way to make one in a page, so a
real file has to be committed.

**Where it came from.** It is a sample published for testing at
<https://heic.digital/samples/>. It is not anybody's personal photograph and
was not produced here. This is written down because it is the only file in this
repository that this repository did not write, and a reader should not have to
guess the provenance of a committed binary.

**What is in it.** EXIF naming Apple, iPad Air (5th generation), iOS 15.6.1 and
a capture time in November 2022, plus an Apple MakerNote and XMP. No GPS.

**Why those details matter to the tests.** The tiling is the point: a converter
that decoded the first tile and stopped would hand back a 512 × 512 picture that
opens perfectly well and looks like a photograph, and only its dimensions would
give it away. The metadata is the other half — the tool can be told to keep it
or drop it, and a fixture with nothing in it could not check either direction.

## Adding another

Prefer generating it. Reach for a committed file only when the format cannot be
produced by a browser or by a small encoder in `lib/`, and when you do, record
here what it is and where it came from.
