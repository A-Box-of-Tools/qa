# fixtures

Almost nothing lives here, and that is deliberate.

Every other fixture this suite uses is **generated**: PNG, ICO, GIF, PDF, WAV
and lossless WebP are written by the encoders in [`lib/`](../lib), and JPEG,
MP4 and lossy WebP are recorded by the browser under test. Generated fixtures
can be shaped to the test — a picture whose secret region is one-pixel stripes,
a recording that is loud then quiet, an animation whose colour sweeps as it
plays — and they cost the repository nothing to carry.

## The exceptions

| File | What it is |
|---|---|
| `chef-with-trumpet.heic` | A 4032 × 3024 HEIC, stored as a grid of 512 × 512 tiles |
| `quadrants.avif` | A 320 × 240 AVIF: four flat quadrants of known colour, opaque. 493 bytes |
| `see-through.avif` | The same picture with an alpha plane: the right half fully transparent. 729 bytes |

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

## The two AVIFs

AVIF cannot be generated here either, for the opposite reason to HEIC: every
current browser *reads* one and none will *write* one — a canvas asked for
`image/avif` hands back a PNG — and the picture inside is an AV1 frame, which is
not a small encoder in `lib/`. It is the premise of
[the tool itself](../../etoolbox/tools/avif-to-jpg/README.md), whose own example
is committed bytes for the same reason.

**Where they came from.** Both were produced here, by ffmpeg 9.0.1 with
`libaom-av1`, from colour sources drawn by ffmpeg itself. Nothing in them came
from anywhere else, and there is no metadata in either. The opaque one:

```
ffmpeg -f lavfi -i color=c=0xC83232:s=160x120 -f lavfi -i color=c=0x32A03C:s=160x120 \
       -f lavfi -i color=c=0x2850C8:s=160x120 -f lavfi -i color=c=0xE6D23C:s=160x120 \
       -filter_complex "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack,format=yuv420p" \
       -frames:v 1 -c:v libaom-av1 -crf 18 -cpu-used 4 -still-picture 1 quadrants.avif
```

The see-through one is the same picture with its alpha set by `geq`
(`a='if(lt(X,160),255,0)'`), then split into a colour stream and an
`alphaextract` stream and both mapped into the file. The tool's README records
that ffmpeg's AVIF muxer used to drop the alpha plane; this build keeps it, and
the control test in `tests/tools/avif-to-jpg.spec.ts` reads the container to
make sure the committed file really has one.

**Why those details matter to the tests.** Flat quadrants are what let a lossy
codec be checked by colour: in the middle of a flat region AV1 and JPEG are both
good to a level or two, so "is the top left still red" has an answer. The
colours are in `lib/avif.ts` beside the reader. The transparent half is the
other half of the tool — a JPEG cannot hold it, so something has to go
underneath, and black is the wrong answer every converter gives by default.

## Adding another

Prefer generating it. Reach for a committed file only when the format cannot be
produced by a browser or by a small encoder in `lib/`, and when you do, record
here what it is and where it came from.
