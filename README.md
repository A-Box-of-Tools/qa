# etoolbox-qa

A [Playwright](https://playwright.dev/) QA suite for
**[abox.tools](https://abox.tools/)** — the site built by the sibling
[`etoolbox`](../etoolbox) repository. It drives real Chromium under two
projects, **Desktop Chrome** and **Mobile Chrome** (Pixel 5 emulation), so the
same specs run once at a desktop viewport/UA and once at a mobile one.

This suite does not re-test what `etoolbox` already covers itself: its
`tests/python` and `tests/js` unit-test the build and the in-browser file
processing. What lives here is the layer those can't reach — a real Chrome
rendering the generated pages, at both form factors, clicking through them.

## What it checks

| File | What it covers |
|---|---|
| [`tests/hub.spec.ts`](tests/hub.spec.ts) | The front page: every tool listed once, links resolve, language switcher, footer, navigation, no console errors |
| [`tests/tool-pages.spec.ts`](tests/tool-pages.spec.ts) | Every tool page (discovered from the checkout, not hand-listed): frame renders, drop zone is wired up, privacy panel toggles, no JS errors, and — specific to this site's no-upload promise — no request to a host outside `config/site.toml`'s own CSP allowlist |
| [`tests/responsive.spec.ts`](tests/responsive.spec.ts) | No horizontal overflow, tap targets, header layout — run once per viewport since it's the same spec under both projects |
| [`tests/accessibility.spec.ts`](tests/accessibility.spec.ts) | `axe-core` (serious/critical) on every page — all tools, hub, RTL hub, guides, legal, roadmap, 404 — plus loaded/result/error states, dark mode, and Tab-reachability of every file picker |

`lib/tools.ts` and `lib/csp.ts` read the tool list and the CSP allowlist
straight out of the `etoolbox` checkout at test time, the same way its own
`build.py` avoids a second hand-kept list — add a tool or widen the CSP over
there and this suite picks it up with nothing to update here.

## Setup

```bash
npm install
npx playwright install chromium
```

## Running

By default this builds and serves the sibling `../etoolbox` checkout itself
(`python build.py`, then its own `serve.ps1`) and points Chrome at
`http://localhost:8080`:

```bash
npm test                 # both projects
npm run test:desktop     # Desktop Chrome only
npm run test:mobile      # Mobile Chrome only
npm run test:headed      # watch it click through the site
npm run test:ui          # Playwright's interactive UI mode
npm run report           # open the last HTML report
```

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

It runs on a schedule, on every push to `main`, and on demand (`workflow_dispatch`, optionally against a different `base_url`). The suite is split across four runners and stitched back into one report by `merge-reports`. The workflow still fails visibly when the suite fails - only after the report is published, so a red run always has a page to point at.

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
  ICO, DICOM and HEIC readers and writers for exactly that reason). The
  coverage guard in `tests/coverage.spec.ts` fails, and a workflow opens an
  issue, the moment a tool ships without one.
