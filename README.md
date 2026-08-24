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
| [`tests/accessibility.spec.ts`](tests/accessibility.spec.ts) | `axe-core` scan (serious/critical only) on the hub and a sample of tool pages |

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

## Notes

- `tests/tool-pages.spec.ts`'s CSP-allowlist check is a regression guard, not
  a security audit: it fails if a page contacts a host the site hasn't
  already declared, which is exactly the class of drift `etoolbox`'s own
  README warns about ("a tool missing an origin showed a blank ad slot").
- File-upload/processing flows (drop a real image, get a real result) aren't
  covered here yet — that logic already has direct unit tests in
  `etoolbox/tests/js`. Add fixtures under a new `fixtures/` folder and
  per-tool specs here if you want true end-to-end coverage of the pipelines
  themselves.
