import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL, ETOOLBOX_DIR } from '../../lib/site';
import { liveRendezvous } from '../../lib/rendezvous';
import { withoutThirdParties } from '../../lib/engine';
import { cameraHooks, movingVideo } from '../../lib/camera-fixtures';
import { tabHooks, flowingTab, noTabMedia } from '../../lib/share-tab';
import { voiceHooks, receivedAudio, microphoneEnabled, outputRms, voiceSnapshot } from '../../lib/voice-fixtures';
import { observePairing, pairingSnapshot, attachPairingDiagnostics } from '../../lib/pairing-diagnostics';

const tools = ['share-text', 'share-tab', 'remote-camera', 'walkie-talkie', 'voice-oncall'] as const;
type Tool = typeof tools[number];
const enabled = process.env.RUN_CLOUD_RELAY === '1';
const TEXT = 'QA relay private content 6ef719';
const PASSWORD = 'QA relay admission 9f38';
const sourceHasRelay = tools.every(tool => {
  const file = path.join(ETOOLBOX_DIR, 'tools', tool, 'tool.toml');
  return fs.existsSync(file) && /^supports_relay\s*=\s*true\s*$/m.test(fs.readFileSync(file, 'utf8'));
});
const status = { 'share-text': '#view-status', 'share-tab': '#viewer-status', 'remote-camera': '#viewer-status',
  'walkie-talkie': '#wt-error-text', 'voice-oncall': '#vi-status-text' };

// A normal production report must never allocate TURN traffic accidentally.
// Traces include WebSocket frames, so only our allowlisted diagnostic attachment
// is retained; neither minted credentials nor private invitations enter reports.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'default', retries: 0 });
test.beforeAll(async ({ request }, info) => {
  if (!enabled) return;
  test.setTimeout(120_000);
  const target = new URL(BASE_URL);
  expect(target.protocol === 'https:' && target.hostname.endsWith('.abox-preview.pages.dev')).toBe(true);
  expect(process.env.WEBSITE_SHA).toMatch(/^[a-f0-9]{40}$/);
  const built = process.env.PAIRING_EXPECTED_DIR;
  expect(Boolean(built && fs.existsSync(built)), 'Build the pinned source before allocating TURN.').toBe(true);
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const evidence = [];
  for (const tool of tools) {
    const directory = path.join(built!, tool);
    const expected = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    const response = await request.get(new URL('/' + tool + '/', BASE_URL).href);
    expect(response.ok(), tool + ' preview must be readable before pairing').toBe(true);
    const actual = await response.text();
    const main = (html: string) => {
      const matches = [...html.matchAll(/<main\b[^>]*>[\s\S]*?<\/main>/g)];
      expect(matches.length).toBe(1);
      return matches[0][0];
    };
    // The release footer can legitimately differ with fetched version tags;
    // the rendered tool and its complete runtime graph must match exactly.
    expect(digest(main(actual)), tool + ' rendered tool differs from the pinned build').toBe(digest(main(expected)));
    const version = expected.match(/data-pairing-version="([a-f0-9]{10})"/)?.[1];
    expect(version, tool + ' source build must identify its JS graph').toBeTruthy();
    expect(actual.match(/data-pairing-version="([a-f0-9]{10})"/)?.[1], tool + ' deployed JS graph').toBe(version);
    const assets: string[] = ['styles.css'];
    const visit = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
        const name = relative + '/' + entry.name;
        if (entry.isDirectory()) visit(name); else assets.push(name);
      }
    };
    visit('src');
    for (let offset = 0; offset < assets.length; offset += 4) {
      await Promise.all(assets.slice(offset, offset + 4).map(async asset => {
        const url = new URL('/' + tool + '/' + asset, BASE_URL);
        url.searchParams.set('v', version!);
        const deployed = await request.get(url.href);
        expect(deployed.ok(), tool + '/' + asset + ' must be deployed').toBe(true);
        expect(digest(await deployed.body()), tool + '/' + asset + ' differs from the pinned build')
          .toBe(digest(fs.readFileSync(path.join(directory, asset))));
      }));
    }
    evidence.push({ tool, graph: version, assets: assets.length, main: digest(main(actual)) });
  }
  await info.attach('verified-preview-source', { body: JSON.stringify({ websiteSHA: process.env.WEBSITE_SHA, tools: evidence }, null, 2),
    contentType: 'application/json' });
});
test.beforeEach(() => {
  test.skip(!enabled, 'Real TURN checks require the explicit development-only Cloud relay workflow.');
  expect(sourceHasRelay, 'The pinned website source must support all five relay adapters.').toBe(true);
  const url = new URL(BASE_URL);
  expect(url.protocol === 'https:' && url.hostname.endsWith('.abox-preview.pages.dev'),
    'Real TURN QA is restricted to a development preview.').toBe(true);
  expect(liveRendezvous('shared/js/voice-session.js')).toBe('wss://rendezvous-dev.abox.tools');
  test.setTimeout(120_000);
});

async function newSide(browser: Browser, tool: Tool, role: 'host' | 'client', tls443 = false) {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    await observePairing(context, tls443);
    if (tool === 'share-tab') await tabHooks(context, { live: true });
    const page = await context.newPage();
    await withoutThirdParties(page);
    if (tool === 'remote-camera') await cameraHooks(page, role === 'host' ? 'allow' : 'deny', 'live');
    if (tool === 'walkie-talkie') await voiceHooks(page, role === 'host' ? 'allow' : 'deny');
    if (tool === 'voice-oncall') await voiceHooks(page, role === 'client' ? 'allow' : 'deny');
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function startHost(host: Page, tool: Tool, mode = 'relay') {
  await host.goto('/' + tool + '/');
  await expect(host.locator('#pairing-transport')).toHaveValue('direct');
  await host.locator('#pairing-transport').selectOption(mode);
  if (mode === 'relay') await expect(host.locator('#pairing-transport-note')).toContainText('Cloudflare');
  let input: string;
  if (tool === 'share-text') {
    await host.locator('#text').fill(TEXT);
    await host.locator('#code').fill('qa-relay-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
    await host.locator('#private').check();
    await host.locator('#discoverable').uncheck();
    await host.locator('#fileinput').setInputFiles({ name: 'relay.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16_384, 73) });
    await host.locator('#publish').click();
    input = '#link';
  } else if (tool === 'share-tab') {
    await host.locator('#host-discoverable').uncheck();
    await host.locator('#host-start').click();
    input = '#share-link';
  } else if (tool === 'remote-camera') {
    await host.locator('#camera-discoverable').uncheck();
    await host.locator('#camera-start').click();
    input = '#camera-link';
  } else if (tool === 'walkie-talkie') {
    await host.locator('#wt-discover').uncheck();
    await host.locator('#wt-start').click();
    input = '#wt-link';
  } else {
    await host.locator('#vi-tab-host').click();
    await host.locator('#vi-room-name').fill('QA relay pager');
    await host.locator('#vi-password-required').check();
    await host.locator('#vi-host-password').fill(PASSWORD);
    await host.locator('#vi-start').click();
    input = '#vi-link';
  }
  // Do not print the private link in a failed assertion.
  await expect.poll(async () => Boolean(await host.locator(input).inputValue()), { timeout: 25_000 }).toBe(true);
  const invitation = await host.locator(input).inputValue();
  expect(new URL(invitation).searchParams.get('transport')).toBe(mode);
  await expect(host.locator('#pairing-transport')).toBeDisabled();
  return invitation;
}

async function openClient(client: Page, tool: Tool, invitation: string) {
  await client.goto(invitation);
  await expect(client.locator('#pairing-transport')).toHaveValue('relay');
  await expect(client.locator('#pairing-transport-note')).toBeVisible();
  const state = await pairingSnapshot(client);
  expect(state.peers).toEqual([]);
  expect(state.relayRequests).toBe(0);
  if (state.capture) expect(state.capture.calls).toBe(0);
  if (tool === 'share-tab' || tool === 'remote-camera') await client.locator('#viewer-name').fill('QA approved viewer');
}

async function join(client: Page, tool: Tool) {
  if (tool === 'voice-oncall') await client.locator('#vi-sender-password').fill(PASSWORD);
  const control = { 'share-text': '#connect', 'share-tab': '#viewer-connect', 'remote-camera': '#viewer-connect',
    'walkie-talkie': '#wt-connect-listener', 'voice-oncall': '#vi-join' }[tool];
  await client.locator(control).click();
}

async function relayConnected(page: Page, tls443 = false) {
  await expect.poll(async () => {
    const state = await pairingSnapshot(page);
    const connected = state.peers?.filter((peer: any) => peer.connection === 'connected') ?? [];
    return connected.length > 0 && connected.every((peer: any) => peer.policy === 'relay'
      && peer.selected.length > 0 && peer.selected.every((pair: any) => pair.local === 'relay' && pair.remote === 'relay'));
  }, { timeout: 30_000 }).toBe(true);
  const state = await pairingSnapshot(page);
  expect(state.relayRequests).toBeGreaterThan(0);
  expect(state.credentialReplies).toBeGreaterThan(0);
  expect(state.credentialErrors).toBe(0);
  expect(state.candidateTypes).not.toEqual(expect.arrayContaining(['host']));
  expect(state.candidateTypes).not.toEqual(expect.arrayContaining(['srflx']));
  await expect(page.locator('#pairing-route')).toContainText('Cloud relay');
  if (tls443) {
    expect(state.tlsConfigurations).toBeGreaterThan(0);
    expect(state.peers.filter((peer: any) => peer.connection === 'connected')
      .every((peer: any) => peer.selected.every((pair: any) => pair.relayProtocol === 'tls'))).toBe(true);
  }
}

async function approveAndDeliver(host: Page, client: Page, tool: Tool) {
  if (tool === 'share-text') {
    await expect(client.locator('#knockrow')).toBeVisible({ timeout: 30_000 });
    await expect(client.locator('#panel')).not.toContainText(TEXT);
    await expect(client.locator('#filelist button')).toHaveCount(0);
    await client.locator('#knock').fill('QA private relay reader');
    await client.locator('#send-knock').click();
    await expect(host.locator('#requests')).toContainText('QA private relay reader');
    await host.locator('#requests button').first().click();
    await expect(client.locator('#panel')).toContainText(TEXT, { timeout: 20_000 });
    const file = client.locator('#filelist .filerow').filter({ hasText: 'relay.bin' });
    await expect(file).toBeVisible();
    const [download] = await Promise.all([client.waitForEvent('download'), file.locator('[data-file-download]').click()]);
    expect(fs.readFileSync((await download.path())!)).toEqual(Buffer.alloc(16_384, 73));
    await host.locator('#text').fill(TEXT + ' updated');
    await expect(client.locator('#panel')).toContainText(TEXT + ' updated');
  } else if (tool === 'share-tab') {
    const request = host.locator('#viewer-requests li').filter({ hasText: 'QA approved viewer' });
    await expect(request).toBeVisible({ timeout: 30_000 });
    await noTabMedia(host, client);
    await request.getByRole('button', { name: /Allow|Approve/ }).click();
    await flowingTab(client, { pixelEvidence: true });
  } else if (tool === 'remote-camera') {
    await expect(host.locator('#camera-request-dialog')).toBeVisible({ timeout: 30_000 });
    expect(await client.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
    await host.locator('#camera-request-later').click();
    await expect(host.locator('#camera-request-dialog')).toBeHidden();
    await host.locator('[data-action="approve"]').click();
    await movingVideo(client);
    const decoded = async () => {
      const state = await pairingSnapshot(client);
      return state.peers.filter((peer: any) => peer.connection === 'connected')
        .flatMap((peer: any) => peer.media).filter((media: any) => media.type === 'inbound-rtp' && media.kind === 'video')
        .reduce((sum: number, media: any) => sum + (media.bytesReceived > 0 ? media.framesDecoded ?? 0 : 0), 0);
    };
    await expect.poll(decoded).toBeGreaterThan(2);
    const first = await decoded();
    await expect.poll(decoded).toBeGreaterThan(first + 2);
    expect(await client.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
  } else if (tool === 'walkie-talkie') {
    await expect(client.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 30_000 });
    expect(await microphoneEnabled(host)).toBe(false);
    expect(await client.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    if (await client.locator('#wt-playback-note').isVisible()) await client.locator('#wt-mute').click();
    const before = await receivedAudio(client);
    await host.locator('#wt-toggle').click();
    await expect.poll(() => microphoneEnabled(host)).toBe(true);
    await expect.poll(async () => (await receivedAudio(client)).packets).toBeGreaterThan(before.packets);
    await expect.poll(async () => (await receivedAudio(client)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
    await host.locator('#wt-toggle').click();
    expect(await microphoneEnabled(host)).toBe(false);
  } else {
    await expect(client.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 30_000 });
    expect(await microphoneEnabled(client)).toBe(false);
    expect(await host.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    const before = await receivedAudio(host);
    await client.locator('#vi-toggle').click();
    await expect.poll(() => outputRms(host), { timeout: 20_000 }).toBeGreaterThan(0.01);
    await expect.poll(async () => (await receivedAudio(host)).packets).toBeGreaterThan(before.packets);
    const name = await host.locator('#vi-participants .vi-participant-name').innerText();
    await host.getByRole('button', { name: 'Mute ' + name, exact: true }).click();
    await expect(client.locator('#vi-status-text')).toContainText('host muted you');
    await expect.poll(() => microphoneEnabled(client)).toBe(false);
    await expect.poll(() => outputRms(host)).toBeLessThan(0.00001);
    await host.getByRole('button', { name: 'Unmute ' + name, exact: true }).click();
    expect(await microphoneEnabled(client)).toBe(false);
  }
}

async function stopHost(host: Page, tool: Tool) {
  const control = { 'share-text': '#stop', 'share-tab': '#host-stop', 'remote-camera': '#camera-stop',
    'walkie-talkie': '#wt-end', 'voice-oncall': '#vi-end' }[tool];
  await host.locator(control).click();
  if (tool === 'remote-camera' && await host.locator('#camera-stop-dialog').isVisible()) await host.locator('#camera-stop-confirm').click();
}

async function closed(page: Page) {
  await expect.poll(async () => (await pairingSnapshot(page)).peers?.every((peer: any) => peer.connection === 'closed')).toBe(true);
  const state = await pairingSnapshot(page);
  if (state.capture) expect(state.capture.tracks.every((track: any) => track.state === 'ended')).toBe(true);
  const before = state.peers?.length;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  expect((await pairingSnapshot(page)).peers?.length).toBe(before);
}

async function withPair(browser: Browser, tool: Tool, work: (host: Page, client: Page) => Promise<void>, tls443 = false) {
  let host: Awaited<ReturnType<typeof newSide>> | undefined;
  let client: Awaited<ReturnType<typeof newSide>> | undefined;
  let completed = false;
  try {
    host = await newSide(browser, tool, 'host', tls443);
    client = await newSide(browser, tool, 'client', tls443);
    await work(host.page, client.page);
    completed = true;
  }
  finally {
    try {
      const pages: Record<string, Page> = {};
      if (host) pages.host = host.page;
      if (client) pages.client = client.page;
      try { await attachPairingDiagnostics(test.info(), pages, 'final'); }
      catch { test.info().annotations.push({ type: 'diagnostics', description: 'Pairing diagnostics could not be attached.' }); }
      if (tool === 'walkie-talkie' || tool === 'voice-oncall') {
        const audio: Record<string, unknown> = {};
        for (const [role, page] of Object.entries(pages)) {
          try {
            audio[role] = { ...await voiceSnapshot(page), page: await page.evaluate(() => ({
              focused: document.hasFocus(), visibility: document.visibilityState,
              activated: navigator.userActivation?.hasBeenActive ?? null,
              captureClock: ((window as any).__voiceQA?.captureContexts ?? []).map((context: AudioContext) =>
                ({ state: context.state, time: context.currentTime })),
            })) };
          } catch { audio[role] = { unavailable: true }; }
        }
        try {
          await test.info().attach('address-free-voice-diagnostics', {
            body: JSON.stringify(audio, null, 2), contentType: 'application/json',
          });
        } catch { test.info().annotations.push({ type: 'diagnostics', description: 'Voice diagnostics could not be attached.' }); }
      }
    } finally {
      const contexts = [host?.context, client?.context].filter((context): context is BrowserContext => Boolean(context));
      const closing = await Promise.allSettled(contexts.map(context => context.close()));
      if (completed && closing.some(result => result.status === 'rejected')) throw new Error('A QA browser context could not be closed.');
    }
  }
}

for (const tool of tools) {
  test(tool + ': Cloud relay carries approved native content and Stop releases both peers', async ({ browser }) => {
    await withPair(browser, tool, async (host, client) => {
      const invitation = await startHost(host, tool);
      await openClient(client, tool, invitation);
      if (tool === 'voice-oncall') {
        await client.locator('#vi-sender-password').fill('wrong QA password');
        await client.locator('#vi-join').click();
        await expect(client.locator('#vi-status-text')).toContainText('password did not match', { timeout: 20_000 });
        expect((await pairingSnapshot(client)).relayRequests).toBe(0);
        expect((await pairingSnapshot(client)).peers).toEqual([]);
      }
      await join(client, tool);
      await approveAndDeliver(host, client, tool);
      await relayConnected(host); await relayConnected(client);
      await attachPairingDiagnostics(test.info(), { host, client }, 'connected');
      await stopHost(host, tool);
      await closed(host); await closed(client);
      if (tool === 'share-text') await expect(client.locator('#panel')).not.toContainText(TEXT);
    });
  });
}

test('share-text: real TURN TLS on port 443 carries approved text and binary bytes', async ({ browser }) => {
  await withPair(browser, 'share-text', async (host, client) => {
    const invitation = await startHost(host, 'share-text');
    await openClient(client, 'share-text', invitation);
    await join(client, 'share-text');
    await approveAndDeliver(host, client, 'share-text');
    await relayConnected(host, true); await relayConnected(client, true);
    await attachPairingDiagnostics(test.info(), { host, client }, 'tls-connected');
    await stopHost(host, 'share-text'); await closed(host); await closed(client);
  }, true);
});

/** Fault injection changes only a credential reply. Authentication, admission
 * and signaling use the real development worker. No fake reply can produce a
 * passing connection or reach TURN: expired replies are rejected before a PC. */
async function credentialFault(context: BrowserContext, kind: 'expired' | 'unavailable' | 'hold') {
  let seen = 0;
  let release: (() => void) | undefined;
  await context.routeWebSocket('wss://rendezvous-dev.abox.tools/**', route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { route.send(message); return; }
      if (kind === 'hold' && frame.type === 'relay-credentials') release = () => {
        try { route.send(message); } catch { /* Closing the native socket also fences late delivery. */ }
      };
      else route.send(message);
    });
    route.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      if (frame.type !== 'relay-request') { server.send(message); return; }
      seen++;
      if (kind === 'hold') { server.send(message); return; }
      const send = () => route.send(JSON.stringify(kind === 'unavailable'
        ? { type: 'relay-credentials', id: frame.id, error: 'unavailable' }
        : { type: 'relay-credentials', id: frame.id, expiresAt: Date.now() - 1,
          iceServers: [{ urls: 'turns:invalid.example:443?transport=tcp', username: 'qa-unused', credential: 'qa-unused' }] }));
      send();
    });
  });
  return { seen: () => seen, ready: () => Boolean(release), release: () => release?.() };
}

for (const tool of tools) {
  test(tool + ': expired relay credentials fail closed without a Direct peer', async ({ browser }) => {
    await withPair(browser, tool, async (host, client) => {
      const fault = await credentialFault(client.context(), 'expired');
      const invitation = await startHost(host, tool);
      await openClient(client, tool, invitation); await join(client, tool);
      await expect.poll(fault.seen).toBe(1);
      const text = await client.locator('[data-phrase="transport.invalid"]').textContent();
      await expect(client.locator(status[tool])).toContainText(text!, { timeout: 15_000 });
      expect((await pairingSnapshot(client)).peers).toEqual([]);
      await expect(client.locator('#pairing-transport')).toHaveValue('relay');
      await stopHost(host, tool);
    });
  });
}

test('voice-oncall: Disconnect while awaiting credentials ignores the late reply and stops capture', async ({ browser }) => {
  await withPair(browser, 'voice-oncall', async (host, client) => {
    const fault = await credentialFault(client.context(), 'hold');
    const invitation = await startHost(host, 'voice-oncall');
    await openClient(client, 'voice-oncall', invitation); await join(client, 'voice-oncall');
    await expect.poll(fault.seen).toBe(1);
    await expect.poll(fault.ready).toBe(true);
    await client.locator('#vi-leave').click();
    fault.release();
    await expect(client.locator('#vi-join')).toBeVisible();
    expect((await pairingSnapshot(client)).peers).toEqual([]);
    await closed(client); await stopHost(host, 'voice-oncall');
  });
});

test('voice-oncall: unavailable relay service stops capture and never widens to Direct', async ({ browser }) => {
  await withPair(browser, 'voice-oncall', async (host, client) => {
    const fault = await credentialFault(client.context(), 'unavailable');
    const invitation = await startHost(host, 'voice-oncall');
    await openClient(client, 'voice-oncall', invitation); await join(client, 'voice-oncall');
    await expect.poll(fault.seen).toBe(1);
    const text = await client.locator('[data-phrase="transport.unavailable"]').textContent();
    await expect(client.locator('#vi-status-text')).toContainText(text!);
    expect((await pairingSnapshot(client)).peers).toEqual([]);
    await closed(client);
    await expect(client.locator('#pairing-transport')).toHaveValue('relay');
    await stopHost(host, 'voice-oncall');
  });
});

test('walkie-talkie: a Direct invitation cannot join an authenticated relay channel', async ({ browser }) => {
  await withPair(browser, 'walkie-talkie', async (host, client) => {
    const invitation = new URL(await startHost(host, 'walkie-talkie'));
    invitation.searchParams.set('transport', 'direct');
    await client.goto(invitation.href);
    const text = await client.locator('[data-phrase="transport.mismatch"]').textContent();
    await expect(client.locator('#wt-error-text')).toContainText(text!, { timeout: 20_000 });
    expect((await pairingSnapshot(client)).relayRequests).toBe(0);
    expect((await pairingSnapshot(client)).peers).toEqual([]);
    await expect(client.locator('#pairing-transport')).toHaveValue('direct');
    await stopHost(host, 'walkie-talkie');
  });
});
