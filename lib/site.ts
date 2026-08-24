import path from 'node:path';

/**
 * The etoolbox checkout this suite drives a browser against. Defaults to the
 * sibling directory the two projects normally sit in side by side
 * (…/etoolbox-qa and …/etoolbox under the same parent); override with
 * ETOOLBOX_DIR if your checkout lives somewhere else.
 */
export const ETOOLBOX_DIR = process.env.ETOOLBOX_DIR
  ? path.resolve(process.env.ETOOLBOX_DIR)
  : path.resolve(__dirname, '..', '..', 'etoolbox');

export const PORT = Number(process.env.PORT) || 8080;

/**
 * Where the tests point their browser.
 *
 * Left unset, playwright.config.ts builds and serves ETOOLBOX_DIR itself
 * (via its own serve.ps1) and points here. Set BASE_URL to test a server you
 * already started, or the live site, instead - doing so also switches off
 * this suite's own webServer, so it never launches a second build:
 *
 *   BASE_URL=https://abox.tools/ npx playwright test
 */
export const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
