import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { BASE_URL } from '../../lib/site';
import { withoutThirdParties } from '../../lib/engine';
import { voiceApproval, sessionApproval, reviewPairingRequestLater, expectRequestsNearHostControls } from '../../lib/pairing-approval';
import { chooseTransport, expectHostTransportBadge, expectHostTransportRestored } from '../../lib/pairing-transport';
import { voiceHooks, admitsLiveVoice, receivedAudio, outputRms, microphoneEnabled, installVoiceLifecycle } from '../../lib/voice-fixtures';

type VoiceTool = 'walkie-talkie' | 'voice-oncall';
const prefix = (tool: VoiceTool) => tool === 'walkie-talkie' ? 'wt' : 'vi';
const password = 'QA-approval-only-password';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

function countSignals(page: Page) {
  const counts = { sent: 0, received: 0 };
  page.on('websocket', socket => {
    if (!/^\/(broadcast|inbox)\//.test(new URL(socket.url()).pathname)) return;
    const keep = (direction: 'sent' | 'received', frame: { payload: string | Buffer }) => {
      const body = String(frame.payload);
      if (/"type"\s*:\s*"(?:offer|answer|candidate)"/.test(body)) counts[direction]++;
    };
    socket.on('framesent', frame => keep('sent', frame));
    socket.on('framereceived', frame => keep('received', frame));
  });
  return counts;
}

async function privateUntilApproved(client: Page, signals: { sent: number; received: number }) {
  expect(await client.evaluate(() => {
    const qa = (window as any).__voiceQA;
    return { captures: qa.calls.length, tracks: qa.tracks.length, peers: qa.peers.length };
  })).toEqual({ captures: 0, tracks: 0, peers: 0 });
  expect(signals).toEqual({ sent: 0, received: 0 });
  expect((await receivedAudio(client)).packets).toBe(0);
}

async function foreground(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
}

async function voiceTransportState(page: Page) {
  return page.evaluate(async () => {
    const peers: RTCPeerConnection[] = (window as any).__voiceQA?.peers ?? [];
    const result = [];
    for (const peer of peers) {
      const entry = { connection: peer.connectionState, policy: peer.getConfiguration().iceTransportPolicy,
        selected: [] as { local: string; remote: string; bytesSent: number; bytesReceived: number }[] };
      const records: any[] = [];
      try { (await peer.getStats()).forEach(row => records.push(row)); } catch {}
      const byId = new Map(records.map(row => [row.id, row]));
      const selectedIds = new Set(records.filter(row => row.type === 'transport').map(row => row.selectedCandidatePairId));
      for (const pair of records.filter(row => row.type === 'candidate-pair'
          && (selectedIds.has(row.id) || (row.nominated && row.state === 'succeeded')))) {
        entry.selected.push({ local: byId.get(pair.localCandidateId)?.candidateType ?? 'unknown',
          remote: byId.get(pair.remoteCandidateId)?.candidateType ?? 'unknown',
          bytesSent: pair.bytesSent ?? 0, bytesReceived: pair.bytesReceived ?? 0 });
      }
      result.push(entry);
    }
    return result;
  });
}

test('voice-oncall: a locked row asks only for its password, and dismissing it starts nothing', async ({ page }) => {
  test.skip(!voiceApproval('voice-oncall'), 'One-click voice approval is awaiting release.');
  await withoutThirdParties(page);
  await voiceHooks(page, 'deny', true, [{ code: 'a'.repeat(64), name: 'QA locked pager', locked: true, approval: true }]);
  await page.goto('/voice-oncall/');
  const row = page.locator('#vi-rooms .paired-nearby-row');
  const join = row.getByRole('button');
  await expect(join).toHaveText('Join');
  await expect(row.locator('[data-connection-kind="password"]')).toBeVisible();
  await expect(row.locator('[data-connection-kind="approval"]')).toBeVisible();
  for (const dismiss of ['cancel', 'escape']) {
    await join.click();
    await expect(page.locator('#vi-password-dialog')).toBeVisible();
    expect(await page.locator('#vi-password-dialog').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= -1 && bounds.top >= -1
        && bounds.right <= document.documentElement.clientWidth + 1
        && bounds.bottom <= innerHeight + 1;
    }), 'The password prompt fits the active desktop or phone viewport.').toBe(true);
    await expect(page.locator('#vi-join-password')).toBeFocused();
    await expect(page.locator('#vi-sender-name')).toHaveCount(0);
    if (dismiss === 'cancel') await page.locator('#vi-password-cancel').click();
    else await page.locator('#vi-password-dialog').press('Escape');
    await expect(page.locator('#vi-password-dialog')).toBeHidden();
    expect(await page.evaluate(() => {
      const qa = (window as any).__voiceQA;
      return { captures: qa.calls.length, peers: qa.peers.length,
        rooms: qa.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length };
    })).toEqual({ captures: 0, peers: 0, rooms: 0 });
  }
});

for (const tool of ['walkie-talkie', 'voice-oncall'] as const) {
  for (const mode of ['direct', 'relay'] as const) test(`${tool}: ${mode} Join waits privately for approval; dismissal, denial, departure and End retain their meaning`, async ({ page: host, browser, browserName }) => {
    test.skip(!voiceApproval(tool), 'Voice approval is awaiting release.');
    test.skip(browserName !== 'chromium', 'Native generated audio journeys run in Chromium.');
    test.skip(!admitsLiveVoice(), 'The worker does not admit this test origin.');
    test.skip(mode === 'relay' && process.env.RUN_CLOUD_RELAY !== '1', 'Native TURN allocation is an explicit development check.');
    test.skip(mode === 'direct' && process.env.RUN_CLOUD_RELAY === '1', 'The ordinary preview run covers Direct.');
    if (mode === 'relay') expect(new URL(BASE_URL).hostname.endsWith('.abox-preview.pages.dev')).toBe(true);
    test.setTimeout(150_000);
    const id = prefix(tool), name = `QA approval ${test.info().workerIndex}-${Date.now()}`;
    const contexts: BrowserContext[] = [];
    await withoutThirdParties(host);
    await voiceHooks(host, tool === 'walkie-talkie' ? 'allow' : 'deny', true);
    await host.goto('/' + tool + '/');
    if (tool === 'voice-oncall') await host.locator('#vi-tab-host').click();
    await expect(host.locator(`#${id}-require-approval`)).toBeChecked();
    if (mode === 'relay') await chooseTransport(host, 'relay', 'host');
    await host.locator(`#${id}-room-name`).fill(name);
    if (tool === 'walkie-talkie') await host.locator('#wt-discover').uncheck();
    else {
      await host.locator('#vi-password-required').check();
      await host.locator('#vi-host-password').fill(password);
    }
    await host.locator(`#${id}-start`).click();
    await expect.poll(async () => Boolean(await host.locator(`#${id}-link`).inputValue()), { timeout: 20_000 }).toBe(true);
    await expect(host.locator(`#${id}-require-approval`)).toBeDisabled();
    await expectHostTransportBadge(host, mode);
    const invitation = new URL(await host.locator(`#${id}-link`).inputValue());
    const fragment = new URLSearchParams(invitation.hash.slice(1));
    const code = fragment.get('code')!;
    const createClient = async (capture: 'allow' | 'deny' = 'allow') => {
      const context = await browser.newContext({ baseURL: BASE_URL, viewport: host.viewportSize() ?? undefined });
      contexts.push(context);
      const client = await context.newPage();
      await withoutThirdParties(client);
      await voiceHooks(client, tool === 'voice-oncall' ? capture : 'deny', true, [{ code, name,
        listenKey: fragment.get('listen') ?? undefined, locked: tool === 'voice-oncall', transport: mode, approval: true }]);
      const signals = countSignals(client);
      await client.goto('/' + tool + '/');
      const row = client.locator(`#${id}-${tool === 'walkie-talkie' ? 'channels' : 'rooms'} .paired-nearby-row`);
      await expect(row.locator(`[data-connection-kind="${mode}"]`)).toBeVisible();
      await expect(row.locator('[data-connection-kind="approval"]')).toBeVisible();
      await privateUntilApproved(client, signals);
      const join = row.getByRole('button');
      await expect(join).toHaveText('Join');
      await expect(join).toHaveAccessibleName(`Join ${name} via ${mode === 'relay' ? 'Cloud relay' : 'Direct'}`);
      await join.click();
      if (tool === 'voice-oncall') {
        await expect(client.locator('#vi-password-dialog')).toBeVisible();
        await client.locator('#vi-join-password').fill(password);
        await client.locator('#vi-password-join').click();
        await expect(client.locator('#vi-sender-name')).toHaveCount(0);
      }
      await expect(client.locator(`#${id}-status-text`)).toContainText('Waiting for the host to approve', { timeout: 20_000 });
      await privateUntilApproved(client, signals);
      return { client, signals };
    };
    try {
      const first = await createClient();
      const dialog = host.locator('#pairing-request-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-approval-name]')).toHaveText(tool === 'walkie-talkie' ? /^Listener / : /^Caller /);
      await expect(dialog.locator('[data-approval-later]')).toBeFocused();
      await dialog.locator('[data-approval-later]').click();
      await expect(dialog).toBeHidden();
      const request = host.locator(`#${id}-requests [data-peer]`);
      await expect(request).toHaveCount(1);
      await expectRequestsNearHostControls(host, `#${id}-end`);
      await privateUntilApproved(first.client, first.signals);
      await installVoiceLifecycle(first.client);
      await first.client.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      await expect(request).toHaveCount(0);
      await first.client.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(request).toHaveCount(1, { timeout: 20_000 });
      await expect(first.client.locator(`#${id}-status-text`)).toContainText('Waiting for the host to approve');
      await privateUntilApproved(first.client, first.signals);
      await reviewPairingRequestLater(host);
      const staleApprove = await request.locator('[data-action="approve"]').elementHandle();
      await request.locator('[data-action="approve"]').click();
      await expect(request).toHaveCount(0);
      await expect(first.client.locator(`#${id}-status-text`)).toContainText('Connected.', { timeout: 30_000 });
      const captures = await first.client.evaluate(() => (window as any).__voiceQA.calls.length);
      expect(captures).toBe(tool === 'voice-oncall' ? 1 : 0);
      await staleApprove!.evaluate((button: HTMLButtonElement) => button.click());
      expect(await first.client.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(captures);
      if (tool === 'walkie-talkie' && await first.client.locator('#wt-playback-note').isVisible()) await first.client.locator('#wt-mute').click();
      const speaker = tool === 'walkie-talkie' ? host : first.client;
      const listener = tool === 'walkie-talkie' ? first.client : host;
      const beforeAudio = await receivedAudio(listener);
      const positiveAudio = async () => {
        // Oncall plays through Web Audio while its native element stays muted;
        // Chromium's RTP energy alone therefore cannot measure that output.
        if (tool === 'voice-oncall') await expect.poll(() => outputRms(listener), { timeout: 20_000 }).toBeGreaterThan(0.01);
        else await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(beforeAudio.energy);
      };
      await speaker.locator(`#${id}-toggle`).click();
      await expect.poll(() => microphoneEnabled(speaker)).toBe(true);
      await positiveAudio();
      await expect.poll(async () => (await receivedAudio(listener)).packets).toBeGreaterThan(beforeAudio.packets);
      const verifyRelay = async () => {
        if (mode !== 'relay') return;
        for (const side of [host, first.client]) await expect.poll(async () => {
          const connected = (await voiceTransportState(side)).filter(peer => peer.connection === 'connected');
          return connected.length > 0 && connected.every(peer => peer.policy === 'relay' && peer.selected.length > 0
            && peer.selected.every(pair => pair.local === 'relay' && pair.remote === 'relay'
              && pair.bytesSent > 0 && pair.bytesReceived > 0));
        }, { timeout: 20_000 }).toBe(true);
      };
      await verifyRelay();
      if (sessionApproval) {
        await speaker.locator(`#${id}-toggle`).click();
        await expect.poll(() => microphoneEnabled(speaker)).toBe(false);
        await first.client.locator(`#${id}-leave`).click();
        await expect.poll(() => first.client.evaluate(() => (window as any).__voiceQA.peers
          .every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
        await foreground(first.client);
        await expect(request).toHaveCount(0);
        // Deliberate Join is still required; a remembered approval cannot
        // turn foreground recovery into a new call after Disconnect.
        const callsAfterLeave = await first.client.evaluate(() => (window as any).__voiceQA.calls.length);
        await first.client.goto('/' + tool + '/');
        const rejoin = first.client.locator(`#${id}-${tool === 'walkie-talkie' ? 'channels' : 'rooms'} .paired-nearby-row`).getByRole('button');
        await expect(rejoin).toHaveText('Join');
        expect(await first.client.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
        expect(await first.client.evaluate(() => (window as any).__voiceQA.peers.length)).toBe(0);
        await rejoin.click();
        if (tool === 'voice-oncall') {
          await first.client.locator('#vi-join-password').fill(password);
          await first.client.locator('#vi-password-join').click();
        }
        await expect(first.client.locator(`#${id}-status-text`)).toContainText('Connected.', { timeout: 30_000 });
        await expect(dialog).toBeHidden();
        await expect(request).toHaveCount(0);
        expect(callsAfterLeave).toBe(tool === 'voice-oncall' ? 1 : 0);
        expect(await first.client.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(tool === 'voice-oncall' ? 1 : 0);
        await expect.poll(() => microphoneEnabled(speaker)).toBe(false);
        if (tool === 'walkie-talkie' && await first.client.locator('#wt-playback-note').isVisible()) await first.client.locator('#wt-mute').click();
        const rejoinedPackets = (await receivedAudio(listener)).packets;
        await speaker.locator(`#${id}-toggle`).click();
        await expect.poll(() => microphoneEnabled(speaker)).toBe(true);
        await positiveAudio();
        await expect.poll(async () => (await receivedAudio(listener)).packets).toBeGreaterThan(rejoinedPackets);
        await verifyRelay();
      }
      const second = await createClient();
      await expect(dialog).toBeVisible();
      await dialog.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(request).toHaveCount(1);
      await privateUntilApproved(second.client, second.signals);
      await request.locator('[data-action="deny"]').click();
      await expect(second.client.locator(`#${id}-status-text`)).toContainText('host declined');
      await foreground(second.client);
      await privateUntilApproved(second.client, second.signals);
      await expect(request).toHaveCount(0);
      await positiveAudio();
      const third = await createClient();
      await expect(dialog).toBeVisible();
      await third.client.locator(`#${id}-leave`).click();
      await expect(dialog).toBeHidden();
      await expect(request).toHaveCount(0);
      await foreground(third.client);
      await privateUntilApproved(third.client, third.signals);
      if (sessionApproval && tool === 'voice-oncall') {
        const caller = await host.locator('#vi-participants .vi-participant-name').innerText();
        await host.getByRole('button', { name: 'Remove ' + caller, exact: true }).click();
        await expect(first.client.locator('#vi-status-text')).toContainText('The host removed you');
        const removed = await first.client.context().newPage();
        await withoutThirdParties(removed); await voiceHooks(removed, 'allow', true);
        const removedSignals = countSignals(removed);
        await removed.goto(invitation.href);
        await removed.locator('#vi-sender-password').fill(password);
        await removed.locator('#vi-join').click();
        await expect(removed.locator('#vi-status-text')).toContainText('The host removed you', { timeout: 20_000 });
        await privateUntilApproved(removed, removedSignals);
        await expect(request).toHaveCount(0);
        await expect(dialog).toBeHidden();
        await foreground(removed);
        await privateUntilApproved(removed, removedSignals);
      }
      const fourth = await createClient();
      await expect(dialog).toBeVisible();
      await reviewPairingRequestLater(host);
      const lateApprove = await request.locator('[data-action="approve"]').elementHandle();
      await host.locator(`#${id}-end`).click();
      await expect(request).toHaveCount(0);
      await expect(dialog).toBeHidden();
      await lateApprove!.evaluate((button: HTMLButtonElement) => button.click());
      await foreground(host); await foreground(fourth.client);
      await privateUntilApproved(fourth.client, fourth.signals);
      await expectHostTransportRestored(host);
      await expect.poll(() => first.client.evaluate(() => (window as any).__voiceQA.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
      await expect.poll(() => host.evaluate(() => (window as any).__voiceQA.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
      if (sessionApproval) {
        if (tool === 'voice-oncall') await host.locator('#vi-host-password').fill(password);
        await host.locator(`#${id}-start`).click();
        await expect.poll(async () => Boolean(await host.locator(`#${id}-link`).inputValue()), { timeout: 20_000 }).toBe(true);
        const nextInvitation = await host.locator(`#${id}-link`).inputValue();
        const newSessionSignals = countSignals(first.client);
        await first.client.goto(nextInvitation);
        if (tool === 'voice-oncall') {
          await first.client.locator('#vi-sender-password').fill(password);
          await first.client.locator('#vi-join').click();
        } else if (mode === 'relay') await first.client.locator('#wt-connect-listener').click();
        await expect(first.client.locator(`#${id}-status-text`)).toContainText('Waiting for the host to approve', { timeout: 20_000 });
        await privateUntilApproved(first.client, newSessionSignals);
        await expect(dialog).toBeVisible();
        await expect(request).toHaveCount(1);
        await reviewPairingRequestLater(host);
        await host.locator(`#${id}-end`).click();
        await foreground(first.client);
        await privateUntilApproved(first.client, newSessionSignals);
      }
    } catch (error) {
      await test.info().attach('voice-approval-transports', { contentType: 'application/json',
        body: JSON.stringify({ host: await voiceTransportState(host),
          clients: await Promise.all(contexts.flatMap(context => context.pages()).map(client => voiceTransportState(client))) }) });
      throw error;
    } finally {
      for (const context of contexts) await context.close();
    }
  });
}

test('voice-oncall: denied microphone permission is requested only after approval and can be left safely', async ({ page: host, browser, browserName }) => {
  test.skip(!voiceApproval('voice-oncall'), 'Voice approval is awaiting release.');
  test.skip(browserName !== 'chromium' || !admitsLiveVoice(), 'The live approval handshake runs in Chromium on admitted origins.');
  test.skip(process.env.RUN_CLOUD_RELAY === '1', 'The ordinary preview run covers capture refusal.');
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const sender = await context.newPage();
    await withoutThirdParties(host); await withoutThirdParties(sender);
    await voiceHooks(host, 'deny', true); await voiceHooks(sender, 'deny', true);
    await host.goto('/voice-oncall/');
    await host.locator('#vi-tab-host').click();
    await host.locator('#vi-room-name').fill('QA capture refusal after approval');
    await expect(host.locator('#vi-require-approval')).toBeChecked();
    await host.locator('#vi-start').click();
    await expect.poll(async () => Boolean(await host.locator('#vi-link').inputValue()), { timeout: 20_000 }).toBe(true);
    await sender.goto(await host.locator('#vi-link').inputValue());
    const signals = countSignals(sender);
    await sender.locator('#vi-join').click();
    await expect(sender.locator('#vi-status-text')).toContainText('Waiting for the host to approve', { timeout: 20_000 });
    await privateUntilApproved(sender, signals);
    await expect(host.locator('#pairing-request-dialog')).toBeVisible();
    await host.locator('#pairing-request-dialog [data-approval-approve]').click();
    await expect(sender.locator('#vi-status-text')).toContainText('The microphone stopped or could not start.');
    await expect(sender.locator('#vi-resume')).toBeVisible();
    await expect(sender.locator('#vi-hold')).toBeDisabled();
    expect(await sender.evaluate(() => {
      const qa = (window as any).__voiceQA;
      return { calls: qa.calls, tracks: qa.tracks.length };
    })).toEqual({ calls: [{ audio: true, video: false }], tracks: 0 });
    await sender.locator('#vi-leave').click();
    await foreground(sender);
    expect(await sender.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(1);
    await host.locator('#vi-end').click();
    await expect(host.locator('#vi-requests [data-peer]')).toHaveCount(0);
  } finally { await context.close(); }
});
