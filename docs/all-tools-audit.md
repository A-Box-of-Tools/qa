# All-tools coverage audit

Audit date: 30 September 2026. This review covers the 53 tools in the website
checkout and the corresponding QA source, starting from QA commit
`3bb0c343683f6b68eef4bc6d02dc7b98e0e114be`. The table describes assertions in
the final authored specs, not a claim that every possible scenario exists.

All 53 tools have functional scenarios across 48 spec files. There are 435
`test(...)` source declarations under `tests/tools/`; parameterized declarations
expand when collected, and two declarations check fixtures rather than a tool.
This source count is not a passed-test count. Shared checks are additional.
Syntax and TypeScript checks passed during this review. The new browser cases
must execute in CI against the website preview before they are treated as
passing evidence; no local suites were run for this audit.

## What was added

The selected regressions concentrate on complete advertised workflows and
concrete state bugs. They inspect saved bytes, decoded pixels, samples or PDF
contents where that is the relevant result.

| Area | Added scenarios |
|---|---|
| Text and data | Preserve whitespace through Base64; stop/replace a pending checksum read, including zero selected algorithms; retain distinct generated CSS names; snapshot scanner pages during export. |
| Editing and inspection | Save and reopen edited EXIF in JPEG, PNG and WebP; preserve text-diff final newlines and copied/downloaded differences; inspect independent PDF-to-CSV tables and partially checkable ledger output. |
| Sharing | Transfer binary and empty attachments, enforce admission, and offer no partial download after interruption. |
| Images | Recover from a correctly branded corrupt AVIF; retire stale redaction results and ignore edit/clear/replace races during encoding, including the per-region style selector; inspect ICNS slots and website-pack contents. |
| PDF | Type wrong then correct user passwords and a separate owner password; inspect every PDF in both split-ZIP modes. The encrypted fixture comes from an independent pypdf-produced file. |
| Audio and video | Compare every saved trim-audio sample for reordered Keep and Cut ranges; compare safe trim-video Copy output with its selected source ranges; refuse Copy when a later retained section needs keyframe preroll and verify the same selection's Exact-mode playback. |
| Strengthened media assertions | Compare crop pixels with selected source coordinates; type a video-to-GIF range, width and frame rate and inspect saved timing and the first selected moment; probe the exact soundtrack fixture with the native decoder before testing extraction. |
| GIF | Keep an in-flight export's original frame order/delays for both palette modes; cancel at the final decode without publishing a result, then export successfully. |
| Converter lifecycle | For Compress Video, Convert to MP4, Rotate Video and GIF to MP4, Clear while a real encoder flush is held, and separately Cancel while the final output verification read is held. Require no retired output, then complete another export. The Cancel boundary follows every encode pass, including compressor retuning. |

These regressions accompany website fixes for whitespace handling, stale
checksum publication, generated-name collisions, mutable scanner/GIF exports,
AVIF capability misclassification, stale redaction output and converter
completion after Clear or Cancel. A missing scenario is not itself evidence
that a feature is broken.

## Shared coverage

- [Deployment and locale source checks](../tests/locales/pages.spec.ts)
  independently require every maintained language from `config/site.toml` and
  a sitemap. A missing hub can no longer remove all tests for that language.
  [Parity checks](../tests/locales/parity.spec.ts) also compare placeholder
  multisets and reject duplicate phrase keys.
- [Localized runtime checks](../tests/localized-runtime.spec.ts) inspect all
  53 tools at rest in Spanish and Portuguese. Eighteen also perform a real
  load or operation: Base64, DICOM, Edit Audio, EXIF, GIF Analyzer, GIF Maker,
  Grab Frame, Checksum, Data URI, ICO, Merge PDF, Redact Image, Split GIF,
  Stack Images, Trim Audio, Trim Video, Crop Video and Images to Video.
  Assertions cover rendered text and `aria-label`, `title` and `placeholder`
  attributes, unresolved phrase keys/blanks, copy feedback, DICOM dates,
  segment controls and PDF orientation labels. Six malformed-file families
  and invalid URL import have separate translated-error cases.
- [Offline checks](../tests/offline.spec.ts) install each tool's worker and
  reload its shell and module graph without the network. Base64 additionally
  performs an operation. A controlled loopback server serves the preview's
  exact worker bytes to check fresh online HTML without a worker change,
  cached navigation after stopping that origin and isolated nested-scope
  caches. A separate cache-only worker probes offline emulation before the
  per-tool matrix; an app failure cannot cause a skip. Neither check mutates
  the preview or production.
- [Handoff checks](../tests/handoff.spec.ts) carry a generated PDF from Images
  to PDF into Merge PDF byte-for-byte, confirm one-time consumption and check
  that storage refusal still opens a usable empty destination.
- [Loaded accessibility checks](../tests/loaded-accessibility.spec.ts) add
  six loaded/result interfaces and three error states to the existing resize
  and DICOM journeys. They retain the suite's serious/critical axe threshold.

The pre-existing shared layer still covers every English tool's page frame,
boot errors, initial network allowlist, idle axe findings, phrase leakage,
file-picker keyboard access, mobile button height and relevant frame controls.
Responsive overflow and some page types are deliberately sampled.

## Functional inventory

“Next boundary” is a concrete optional extension, not a new release blocker.
All tools also receive the shared checks above; repeated shared checks are
omitted from the rows. The linked specs are the evidence for each claim.

### Text, data, inspection and document tools

| Tool and spec | Practical scenarios now covered | Next boundary or deliberate limit |
|---|---|---|
| [base64](../tests/tools/base64.spec.ts) | Independent encoded bytes, UTF-8 and escape modes, malformed input, whitespace-only input and empty reset. | Clipboard refusal and every codec's complete UI option combinations. |
| [business-profile-preview](../tests/tools/business-profile-preview.spec.ts) | Truncation, open/closed state, pasted listing, saved PNG and embedded photo. | Save/import a complete listing round trip and fixed-clock overnight hours. |
| [compare-heights](../tests/tools/compare-heights.spec.ts) | Ratios, units, names/ruler, SVG fidelity, untrusted SVG and photo cleanup. | Reorder/delete mixed valid and invalid figures and inspect saved order. |
| [dicom-viewer](../tests/tools/dicom-viewer.spec.ts) | Synthetic identifiers, series size, window/level, file privacy; localized date after load. | Visually distinct out-of-order slices and unsupported pixel-syntax headers. |
| [document-scanner](../tests/tools/document-scanner.spec.ts) | Page geometry and saved documents; export remains consistent through page-list edits and Clear. | Independent skew/corner accuracy for varied real camera geometry. |
| [exif-editor](../tests/tools/exif-editor.spec.ts) | GPS removal, metadata stripping, and saved/reopened edits in JPEG, PNG and WebP with unchanged picture payload. | More tag types, malformed metadata and every editable field. |
| [gif-analyzer](../tests/tools/gif.spec.ts) | Size, frame/loop/delay facts, findings and privacy, plus loaded/error localized copy. | Specific anomaly/report content and unusual extension blocks. |
| [hash-checksum](../tests/tools/hash-checksum.spec.ts) | Independent digest values, comparisons, pending-read stop/replacement and zero-algorithm cancellation; localized clipboard refusal. | Large-file resource behavior on physical devices. |
| [image-to-data-uri](../tests/tools/image-to-data-uri.spec.ts) | Exact decoded PNG bytes, MIME sniffing, CSS wrappers and collision-free multi-file names. | SVG percent/base64 wrappers and the metadata warning. |
| [json-formatter](../tests/tools/json-formatter.spec.ts) | Indentation, minification, sorting, large integers, malformed input and conversions. | Downloaded duplicate-key/numeric-key ordering and valid-to-invalid edits. |
| [password-generator](../tests/tools/password-generator.spec.ts) | Required classes, lookalikes, passphrases, batches, network/storage/autocomplete restrictions. | Saved batch equality and clipboard-refusal recovery. |
| [pdf-to-csv](../tests/tools/pdf-to-csv.spec.ts) | Statement arithmetic, independent nonstatement tables, sparse identifiers and partially checkable ledger output. | Scanned-only and encrypted documents are documented refusals, not OCR/decryption promises. |
| [qr-barcode-reader](../tests/tools/qr-camera.spec.ts) | Generated-code round trips and camera lifecycle/refusal; see also [generator specs](../tests/tools/qr-barcode.spec.ts). | Independent damaged/blank fixtures and unsafe-URI display; fake-camera cases can skip. |
| [qr-barcode](../tests/tools/qr-barcode.spec.ts) | Text, Unicode, URL, Wi-Fi, correction levels, EAN-13 and Code 128 images read back. | vCard punctuation and other supported barcode menu paths. |
| [share-text](../tests/tools/share-text.spec.ts) | Two-browser live text/admission/close, signaling-content separation, exact binary/empty attachment transfer and interrupted-transfer refusal. | Rendezvous/peer connectivity is external; skipped or retried transfers are not clean first-pass evidence. |
| [text-diff](../tests/tools/text-diff.spec.ts) | Display modes and patch/download behavior, including final newline and filtered-view differences. | Very large input and all combinations of display settings. |
| [xml-formatter](../tests/tools/xml-formatter.spec.ts) | Formatting, malformed XML and loss-sensitive structures/conversions. | Every namespace/DTD/CDATA combination through saved output. |
| [yaml-to-json](../tests/tools/yaml-to-json.spec.ts) | Supported YAML forms, JSON output and refusal of unsupported/invalid constructs. | YAML features outside the documented subset remain unsupported. |

### Image and PDF tools

| Tool and spec | Practical scenarios now covered | Next boundary or deliberate limit |
|---|---|---|
| [avif-to-jpg](../tests/tools/avif-to-jpg.spec.ts) | JPEG picture/dimensions, alpha matte, renamed files, examples, decoder refusal and corrupt-then-valid recovery. | Batch reset and duplicate names; actual AVIF capability can skip processing. |
| [compress-image](../tests/tools/compress-image.spec.ts) | Real target ceilings, target comparisons, aspect ratio, WebP and batch outputs. | Byte-identical under-target pass-through, impossible targets and partial-batch cancellation. |
| [compress-pdf](../tests/tools/compress-pdf.spec.ts) | Text/page preservation, scan image shrinkage, preset differences, inventory and replacement. | Metadata toggles, custom DPI, encrypted/corrupt recovery and cancellation. |
| [heic-to-jpg](../tests/tools/heic-to-jpg.spec.ts) | Tiled HEIC picture, JPEG/PNG/WebP formats, quality, EXIF retain/drop and privacy. | Multiple pictures, mixed corrupt/valid batches and engine-load failure. |
| [id-photo](../tests/tools/id-photo.spec.ts) | Indian dimensions/byte range, ICAO/US print sizes and DPI, country selection and privacy. | Independent complete print-sheet layout, signature/custom rules and export-time edits. |
| [image-to-ico](../tests/tools/image-to-ico.spec.ts) | ICO directory/size/picture integrity, all ten ICNS slots, website ZIP assets and references, alpha and opaque platform icons. | All storage-mode/scaling combinations and every source alpha edge. |
| [image-to-svg](../tests/tools/image-to-svg.spec.ts) | Geometry at multiple scales, holes, single-path output, noisy-picture warning and privacy. | Wand edits, undo/reset/threshold interactions and manual subject extraction. |
| [images-to-pdf](../tests/tools/images-to-pdf.spec.ts) | Byte-identical JPEG embedding, page count/order/sizing/orientation and Clear gate; real PDF handoff. | Alpha masks, EXIF-plus-user rotation, progressive/CMYK re-encoding and metadata. |
| [merge-pdf](../tests/tools/merge-pdf.spec.ts) | Merge order/content/ranges, reverse/restore, and independently read every-N/cut-point split ZIPs. | Rotations, bookmarks, forms/links, cancellation and mixed encrypted members. |
| [png-to-webp](../tests/tools/png-to-webp.spec.ts) | Lossless picture/alpha, actual lossy reporting, faint alpha, renamed input and encoder refusal. | Correctly branded corruption, duplicate batch names and encoder-null recovery. |
| [protect-pdf](../tests/tools/protect-pdf.spec.ts) | Independent opening of AES-256/AES-128 output, password agreement, wrong/blank refusal and restrictions-only protection. | Unicode/long passwords, owner-password form path and re-protection. |
| [redact-image](../tests/tools/redact-image.spec.ts) | Saved destructive pixels, preserved markers, styles, undo/clear; stale saved result and encode/edit/replace/clear races, including per-region style changes after saving and during encoding. | Metadata absence, alpha matte and every manipulation geometry. |
| [redact-pdf](../tests/tools/redact-pdf.spec.ts) | Secret absent from saved page text, retained unrelated text, multiple terms and no-match behavior. | Hidden metadata/forms/attachments/OCR copies and case/whole-word controls. |
| [resize-image](../tests/tools/resize-image.spec.ts) | Width/percentage/long edge, no-upscale, fit/fill, PNG, batch outputs and privacy. | Crop coordinates, padding/stretch, pass-through metadata and cancelled batches. |
| [stack-images](../tests/tools/stack-images.spec.ts) | Average/median/lighten/darken/add pixel arithmetic, output sizes, one-frame gate and capability refusal. | Sigma/focus modes, actual alignment, oriented RAW previews and worker cancellation. |
| [svg-to-image](../tests/tools/svg-to-image.spec.ts) | Hostile scripts/remote references, dimensions/density, large-vector output, formats and privacy. | UTF-16/SVGZ, malformed plausible SVG and multi-scale ZIP boundary cases. |
| [unlock-pdf](../tests/tools/unlock-pdf.spec.ts) | Restricted example and independent user/owner-password fixture, wrong-to-correct recovery, encryption removed and exact text/pages retained. | Metadata toggle, certificate encryption and asynchronous cancellation. |
| [watermark-pdf](../tests/tools/watermark-pdf.spec.ts) | Empty-words gate, every/first/tiled placement, shared image/mask and retained source text/pages. | Independently rendered rotated/cropped pages, non-Latin text and async Clear. |
| [webp-to-jpg](../tests/tools/webp-to-jpg.spec.ts) | JPEG quality/picture, duplicate ZIP names, matte/alpha, animation warning, renamed and mixed invalid inputs. | Correctly branded corrupt WebP, reset/re-add and encoder-null recovery. |

### Audio, video and animation tools

| Tool and spec | Practical scenarios now covered | Next boundary or deliberate limit |
|---|---|---|
| [compress-video](../tests/tools/compress-video.spec.ts) | Output under half/quarter target, size/duration, under-target refusal, AAC track presence; Clear during flush and Cancel during final verification, each followed by successful recovery. | Force overshoot/retuning outcomes, copied audio packet equality, long inputs and codec combinations. |
| [convert-to-mp4](../tests/tools/convert-to-mp4.spec.ts) | VP8/Opus to H.264/AAC when available, explicit silence, H.264 copy-mode dimensions/sample count; Clear during flush and Cancel during final verification, each followed by successful recovery. | Copied packet equality, mixed track jobs/timestamps, broader containers and source replacement. |
| [crop-video](../tests/tools/video.spec.ts) | Saved crop dimensions and pixels matching the selected source coordinates rather than whole-frame rescaling; playable output/duration and localized loaded/refusal states. | Rotated or off-centre crop pixel correctness, audio preservation and forced recorder fallback. |
| [edit-audio](../tests/tools/audio.spec.ts) | Recording length/loud-quiet identity, reverse, speed duration, gain, bit depth and malformed inputs. | Frequency proof for keep-pitch, clipping/normalization and multi-channel combinations. |
| [extract-audio-from-video](../tests/tools/extract-audio-from-video.spec.ts) | Exact PCM samples, stereo/mono handling, soundtrack duration/non-silence after an independent native decode of the exact fixture, empty-file/decode refusal and privacy. An app error fails the extraction case. | Genuinely silent video, wider containers and rapid replacement during decoding. |
| [gif-maker](../tests/tools/gif.spec.ts) | Frame count/delay/rate/size, browser-playable output, in-flight palette-export timing/count consistency and final-decode cancellation/retry. | Browser pixel-order/alpha proof; new unit regressions separately prove snapshot RGB order. |
| [gif-to-mp4](../tests/tools/gif-to-mp4.spec.ts) | One sample per frame, total/per-frame timing, short-delay policy, silence and wrong-file refusal; Clear during flush and Cancel during final verification, each followed by successful recovery. | Complex disposal/alpha content and codec-specific output behavior. |
| [grab-frame](../tests/tools/video.spec.ts) | Source-sized images and different pictures at different times; translated result/refusal paths. | End-of-stream seeking, variable frame rate and rotation metadata. |
| [images-to-video](../tests/tools/video-more.spec.ts) | Slideshow duration/dimensions/privacy, capability refusal, translated image-list and invalid-URL feedback. | Forced recorder export, URL download/CORS failures and transitions. |
| [reverse-video](../tests/tools/video-more.spec.ts) | Reversed first picture, dimensions/duration, player-input path and usable bitrate. | Sound reversal, exact complete frame ordering and forced recorder export. |
| [rotate-video](../tests/tools/rotate-video.spec.ts) | Quarter/half-turn matrices, copy-mode dimensions/frame count, baked dimensions and AAC present/omitted; Clear during flush and Cancel during final verification, each followed by successful recovery. | Baked pixel orientation, copied packet equality and pre-rotated/non-H.264 input. |
| [split-gif](../tests/tools/gif.spec.ts) | Frame extraction, selection, saved pictures and invalid-input recovery; [sheet specs](../tests/tools/split-gif-sheet.spec.ts) inspect cell order, size and filename. | Complex disposal/partial frames and all selection/save combinations. |
| [timelapse-video](../tests/tools/video-more.spec.ts) | Expected speed-to-duration relation at multiple speeds. | Saved frame sampling/order, soundtrack policy and fallback encoding. |
| [trim-audio](../tests/tools/audio.spec.ts) | Mark/undo, duration/content, every saved float sample for reordered typed Keep ranges and Cut complement. | Fades, stereo/speed and every boundary overlap combination. |
| [trim-video](../tests/tools/video.spec.ts) | Mark/undo and safe reordered Copy output; refuse Copy when a later retained section needs keyframe preroll, then explicitly select Exact and compare saved duration and source/output frame colors for the Cut complement. | Multi-clip joins, broader re-encode combinations, sound and recorder fallback. |
| [video-to-gif](../tests/tools/video.spec.ts) | Typed 0.5–1.5-second range, 240-pixel width and 10 fps; saved dimensions, frame count, one-second total delay and first-frame color at the selected source moment; playability and separate decode refusal. | Complete sampled-frame sequence, palette/dither/disposal combinations, player fallback and cancellation. |

## Capability and claim boundaries

The four projects cover Chromium and Playwright WebKit with desktop and mobile
emulation. They do not cover Firefox, native Safari, hardware codecs or real
camera/touch devices. Capability probes are independent of the app and can
skip unsupported video/audio processing, camera input, AVIF/WebP, File storage
or service-worker APIs and offline emulation. A refusal scenario does not prove a successful export.
The two strict Video Cutter cases probe the actual fixture through native playback before loading the app; Copy and its refusal guard do not require VideoDecoder. Exact separately probes fixture decoding and H.264 encoding after asserting the Copy refusal.
Passed, flaky and skipped counts must be reported separately after CI.

WebKit can expose APIs whose support probes stall. Those bounded probes may
skip the affected path rather than claiming its refusal UI was exercised.
The audit added converter lifecycle coverage on capable engines; it did not
close the separate gap for forcing every MediaRecorder fallback path. The
extraction spec now decodes the exact recorded fixture with the native audio
decoder before loading it into the tool. Only independent decoder capability
failures can skip the soundtrack case; the tool's own error no longer can.

The offline matrix proves installed shell/module availability and one small
operation on engines whose independent cache-only worker survives offline
emulation. The probe also verifies an online cached response and requires a
page outside its scope to fail offline. A setup failure fails the test rather
than skipping it. Playwright's offline flag can reject WebKit worker responses
before the application runs ([upstream issue](https://github.com/microsoft/playwright/issues/42775));
that capability limitation is measured, not inferred from the browser name.
The controlled generated-worker case still runs without that flag: it closes
the local origin and its sockets, then requires both cached scopes to work.
An origin outage is distinct from universal offline emulation, and neither
case establishes every export while disconnected. Share-text deliberately needs
the network to transfer. Frozen-language archives are a separate deployment
contract; maintained-language checks do not rewrite or establish archive
integrity. Runtime localization checks do not establish linguistic quality.
Loaded axe cases and idle responsive samples do not establish full WCAG,
assistive-technology or every-input-layout compliance.

Initial request allowlisting and per-tool marker assertions are useful
regression guards, not a complete proof that arbitrary file contents cannot
leave the page. The suite does not yet universally reject tool-triggered
binary or same-origin uploads after every action. URL-image import and
share-text signaling/peer transfer are explicit network exceptions and need
their own assertions, rather than a blanket no-network rule.

## Prior sharing flake: observed cause

The previous restoration [QA run 36741184804](https://github.com/A-Box-of-Tools/qa/actions/runs/36741184804)
finished with 4,313 passed, one flaky and 353 skipped cases. The first attempt
of Desktop Chrome's “an open share reaches a second browser” timed out before
the share link appeared. Its retained trace records
`net::ERR_CONNECTION_RESET` while establishing the host WebSocket to the
rendezvous service. The page reported that the introduction server was lost
and was being retried. The test's retry passed.

That is concrete evidence of a connection-establishment failure before peer
content transfer, not evidence of an assertion race. This audit did not drop
the assertion, add a skip, or change the retry policy to hide it. The prior
green run validates its own website revision and cannot substitute for a new
run of the cases added here.
