import { test, expect } from '@playwright/test';
import { rendezvousFromSource } from '../lib/rendezvous';

const source = 'const RENDEZVOUS = rendezvousEndpoint();';
const shared = "const PRODUCTION = 'wss://live.example';\nconst DEVELOPMENT = 'wss://dev.example';\n";

test('pairing source: previews and local builds select the source development service', () => {
  for (const href of ['http://localhost:8080/', 'http://127.0.0.1:8123/',
    'https://abox-preview.pages.dev/', 'https://pr-586.abox-preview.pages.dev/']) {
    expect(rendezvousFromSource(source, shared, href)).toBe('wss://dev.example');
  }
});

test('pairing source: production and lookalikes cannot be overridden by a query or fragment', () => {
  for (const href of ['https://abox.tools/', 'https://abox-preview.pages.dev.example.test/',
    'https://evilabox-preview.pages.dev/', 'http://pr-586.abox-preview.pages.dev/', 'not a URL',
    'https://abox.tools/?rendezvous=wss://dev.example#https://pr-586.abox-preview.pages.dev/']) {
    expect(rendezvousFromSource(source, shared, href)).toBe('wss://live.example');
  }
});

test('pairing source: legacy tool and voice literals remain authoritative for older website sources', () => {
  expect(rendezvousFromSource("const RENDEZVOUS = 'wss://legacy.example';", null,
    'https://pr-586.abox-preview.pages.dev/')).toBe('wss://legacy.example');
  expect(rendezvousFromSource("constructor({ origin = 'wss://legacy-voice.example' }) {}", shared,
    'http://localhost:8080/')).toBe('wss://legacy-voice.example');
});

test('pairing source: a missing selector or development constant fails instead of falling back', () => {
  expect(() => rendezvousFromSource(source, null, 'https://pr-586.abox-preview.pages.dev/')).toThrow();
  expect(() => rendezvousFromSource(source, "const PRODUCTION = 'wss://live.example';",
    'https://pr-586.abox-preview.pages.dev/')).toThrow(/DEVELOPMENT/);
  expect(() => rendezvousFromSource('const unrelated = true;', shared, 'https://abox.tools/')).toThrow();
});
