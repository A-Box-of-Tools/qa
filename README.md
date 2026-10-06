# etoolbox-qa

A [Playwright](https://playwright.dev/) QA suite for
**[abox.tools](https://abox.tools/)** — the site built by the sibling
[`etoolbox`](../etoolbox) repository. Four projects exercise two engines:
**Desktop Chrome**, **Mobile Chrome** (Pixel 5 emulation), **Desktop Safari**,
and **Mobile Safari** (iPhone 13 emulation). The Safari projects run
Playwright's WebKit build; they are not native Safari or a physical iPhone.

This suite does not re-test what `etoolbox` already covers itself: its
`tests/python` and `tests/js` unit-test the build and the in-browser file
processing. What lives here is the layer those can't reach — browsers
rendering the generated pages, at both form factors, clicking through them.

## What it checks

The [all-tools audit](docs/all-tools-audit.md) maps all 53 tools to concrete
functional scenarios, records the additions from the audit, and names the
remaining capability and scenario boundaries.

| File | What it covers |
|---|---|
| [`tests/hub.spec.ts`](tests/hub.spec.ts) | The front page: every tool listed once, links resolve, language switcher, footer, navigation, no console errors |
| [`tests/tool-pages.spec.ts`](tests/tool-pages.spec.ts) | Every tool page (discovered from the checkout, not hand-listed): frame renders, drop zone is wired up, privacy panel toggles, no JS errors, and — specific to this site's no-upload promise — no request to a host outside `config/site.toml`'s own CSP allowlist |
| [`tests/responsive.spec.ts`](tests/responsive.spec.ts) | Sampled horizontal overflow, tap targets and header layout across the four projects |
| [`tests/locales/`](tests/locales) | Every maintained language must be deployed; translated copies preserve IDs, phrase keys and placeholders; translated URLs serve the expected language. These source/HTTP checks run once, under Desktop Chrome. |
| [`tests/localized-runtime.spec.ts`](tests/localized-runtime.spec.ts) | Spanish and Portuguese interface text and accessible attributes on every tool, plus real loaded/result journeys for 18 tools and representative malformed-file errors; catches unresolved phrases/placeholders and translated phrases falling back to English |
| [`tests/accessibility.spec.ts`](tests/accessibility.spec.ts) | `axe-core` serious/critical checks on every English tool, the English/Chinese hubs, a guide and the page types; representative loaded/error/dark states and Tab-reachability of every file picker |
| [`tests/loaded-accessibility.spec.ts`](tests/loaded-accessibility.spec.ts) | Additional loaded/result and error states across text, checksum, PDF, GIF, data-URI and audio interfaces |
| [`tests/offline.spec.ts`](tests/offline.spec.ts) | On engines passing an independent offline-emulation probe, every installed tool reloads its shell and module graph offline; Base64 also performs an offline operation. Actual generated workers on a controlled loopback origin verify fresh online HTML, independent nested caches and fallback after that origin is stopped. |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | A generated PDF reaches the next tool byte-for-byte, is consumed once, and storage refusal opens the destination without partial input |
| [`tests/tools/share-text-local-network.spec.ts`](tests/tools/share-text-local-network.spec.ts) | Discover a Local network share, connect two separate Chromium processes, require private approval, deliver exact text and binary bytes, propagate live edits and clear content on Stop; record browser versions and address-free connection counts |

`lib/tools.ts` and `lib/csp.ts` read the tool list and the CSP allowlist
straight out of the `etoolbox` checkout at test time, the same way its own
`build.py` avoids a second hand-kept list — add a tool or widen the CSP over
there and this suite picks it up with nothing to update here.

## Setup

```bash
npm install
npx playwright install chromium webkit
```

## Running

By default this builds and serves the sibling `../etoolbox` checkout itself
(`python build.py`, then its own `serve.ps1`) and points the browsers at
`http://localhost:8080`:

```bash
npm test                 # all four projects
npm run test:desktop     # Desktop Chrome only
npm run test:mobile      # Mobile Chrome only
npm run test:headed      # watch it click through the site
npm run test:failed      # only what failed last time
npm run test:ui          # Playwright's interactive UI mode
npm run report           # open the last HTML report
```

`test:failed` is Playwright's `--last-failed`, reading the `.last-run.json`
the previous run left in `test-results/`. In CI there is no such file to
read — the runners each threw their machine away — so the Report workflow
takes a `rerun` input instead: give it the id of a run that went red and it
re-runs that run's failures and nothing else, in about three minutes rather
than fourteen. `scripts/failed-cases.mjs` is the part that turns one into the
other.

### Pointing at something else

```bash
# A checkout that isn't the sibling directory:
ETOOLBOX_DIR=/path/to/etoolbox npx playwright test

# A server you already started (npm test's own webServer is skipped
# entirely in this case, so it never launches a second build):
BASE_URL=http://localhost:3000 npx playwright test

# The live site:
BASE_URL=https://abox.tools/ npx playwright test
```

## Requirements

Building `etoolbox` needs Python 3.11+ on `PATH` (see its own README) — only
if you let this suite build it for you; pointing `BASE_URL` at something
already running needs nothing but Node.

## Published report

[`.github/workflows/report.yml`](.github/workflows/report.yml) runs this suite against `https://abox.tools/` and publishes the HTML report to the `gh-pages` branch, which GitHub Pages serves at:

**https://a-box-of-tools.github.io/qa/**

It runs on a schedule, on every push to `main`, and on demand (`workflow_dispatch`, optionally against a different `base_url`). The suite is split across sixteen slices and stitched back into one report by `merge-reports`. The workflow still fails visibly when the suite fails - only after the report is published, so a red run always has a page to point at.

## What a passing run proves

A green project proves the cases it executed, not every feature of that
browser. Capability probes can skip video/audio processing, camera input,
AVIF or WebP support, or storing a File in IndexedDB when the test engine
cannot perform them. Corresponding refusals have separate scenarios where the
engine can remain alive long enough to show one. A missing service-worker API
or failed independent offline-emulation probe produces an explicit offline
skip. The latter uses a cache-only worker unrelated to the website; a tool's
own failure never skips its test. Counts of passed, flaky and
skipped cases are reported separately on the website commit.

WebKit's codec and storage capabilities differ from native Safari's. Firefox
and physical devices are not projects in this suite. Native Safari/device
checks remain useful for those boundaries; emulated phone viewports do not
prove a hardware codec, camera or touch implementation.

Local network sharing runs on one CI machine, using bundled Chromium in two
separate processes. It does not prove that multicast name lookup crosses a
router or that two Windows Chrome installations can connect. The
[two-PC Local network checklist](docs/share-text-local-network.md) records that
separate check, including exact browser versions and restart/update recovery.
Different versions need not match. A failed connection must remain recorded
even if updating and relaunching makes the next attempt work.

The offline matrix verifies installed page/module availability for every tool
on engines supporting offline emulation, plus a small real operation, not
every export format without a connection.
Share-text's shell can reload offline; sharing itself deliberately needs the
network. The controlled cache test uses the deployed worker's unchanged bytes
on a local origin and never modifies the preview or production deployment.
Its fallback checks stop that server and close its sockets, avoiding the
[WebKit offline-emulation bug](https://github.com/microsoft/playwright/issues/42775)
without skipping the actual generated-worker assertions. An origin outage is
not the same condition as universal offline emulation.

Localization checks cover structure and runtime copy, not linguistic quality.
They allow technical identifiers and file content rather than calling those
English leaks. Accessibility is a serious/critical axe gate with representative
loaded/error states and keyboard checks, not a claim of full WCAG compliance.
The idle layout checks sample tools; not every possible combination of inputs,
settings, language and viewport is measured.

Full preview/release runs require the maintained languages named by the source
checkout, excluding `frozen_languages` in site configuration. A missing hub
must fail rather than quietly remove that language's checks. Frozen archive
pages are a separate deployment contract and are not rewritten by these specs.

### Failure issues

[`scripts/triage-failures.mjs`](scripts/triage-failures.mjs) turns that run's results into GitHub issues: one per failing test, listing which projects fail it, and **it closes the issue itself once the test passes again**. Issues are edited rather than duplicated while a failure persists, so a fortnight-long failure does not send a fortnight of mail, and the body says how long it has been broken.

It is careful in two directions. It never closes an issue for a test it did not watch pass - a partial run proves nothing, so nothing is closed after one. And past a dozen simultaneous failures it files a single issue instead of a dozen, because that many at once is usually one cause (the site down, a half-finished deploy) and a bot people mute is worse than no bot.

Only runs from `main` against production file issues; a dispatch at some other `base_url` never does.

## Notes

- `tests/tool-pages.spec.ts`'s CSP-allowlist check is a regression guard, not
  a security audit: it fails if a page contacts a host the site hasn't
  already declared, which is exactly the class of drift `etoolbox`'s own
  README warns about ("a tool missing an origin showed a blank ad slot").
- Every tool also has a functional spec under `tests/tools/` — real files in,
  the downloaded result decoded and measured against an independent
  implementation (`lib/` carries its own PNG, GIF, PDF, JPEG/EXIF, MP4, WAV,
  ICO, DICOM, HEIC, WebP, AVIF and zip readers and writers for exactly that
  reason). A tool
  that ships without one does not turn a run red — the tool and its spec live
  in different repositories and cannot land together — but `tests/coverage.spec.ts`
  writes it down, every run says so in a notice, and on production
  `scripts/take-stock.mjs` keeps one issue, "Tools and specs out of step",
  open until the spec exists (and a spec whose tool has gone is listed the
  same way).
