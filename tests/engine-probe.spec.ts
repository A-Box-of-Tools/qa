import { test, expect, type Page } from '@playwright/test';
import { setImmediate } from 'node:timers/promises';
import { onAPageOfItsOwn } from '../lib/engine';

test('engine probes finish scratch-page cleanup before returning to context-wide setup', async () => {
  for (const fails of [false, true]) {
    let beganClose!: () => void, finishClose!: () => void;
    const closing = new Promise<void>(resolve => { beganClose = resolve; });
    const closed = new Promise<void>(resolve => { finishClose = resolve; });
    const scratch = { goto: async () => {}, close: () => { beganClose(); return closed; } };
    const page = { context: () => ({ newPage: async () => scratch }) } as unknown as Page;
    const failure = new Error('probe failed');
    let settled = false;
    const result = onAPageOfItsOwn(page, async () => { if (fails) throw failure; return 42; });
    const observed = result.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await closing;
    // Drain promise callbacks without a timing-based delay or a real browser.
    await setImmediate();
    try { expect(settled).toBe(false); }
    finally { finishClose(); }
    expect(await observed).toEqual(fails ? { error: failure } : { value: 42 });
  }
});
