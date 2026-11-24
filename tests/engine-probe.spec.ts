import { test, expect, type Page } from '@playwright/test';
import { setImmediate } from 'node:timers/promises';
import { ask, NotAsked, onAPageOfItsOwn, wasSilent } from '../lib/engine';

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

/**
 * A page that is only what ask() and onAPageOfItsOwn() touch: an engine to
 * file the answer under, and a page of the probe's own whose arrival each case
 * decides. No browser and no network, so what these cases show is the
 * bookkeeping and nothing else.
 */
function pretend(arrival: () => Promise<void>): Page {
  const own = { goto: arrival, close: async () => {} };
  return {
    context: () => ({
      browser: () => ({ browserType: () => ({ name: () => 'pretend' }) }),
      newPage: async () => own,
    }),
  } as unknown as Page;
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const RESET = 'page.goto: net::ERR_CONNECTION_RESET at https://site.test/\nCall log:\n  - navigating to "https://site.test/"';

/** A question nobody else in the run is asking: the notebook belongs to every worker of it. */
let questions = 0;
function fresh(about: string): string {
  questions += 1;
  return `probe-spec-${about}-${process.pid}-${Date.now()}-${questions}`;
}

test('a question that was never put is not an answer, and is not remembered', async () => {
  const question = fresh('never-put');
  let loads = 0;
  let put = 0;
  const page = pretend(async () => {
    loads += 1;
    if (loads === 1) throw new Error(RESET);
  });
  const asking = () => ask(page, question, () => onAPageOfItsOwn(page, async () => { put += 1; return true; }), false);

  const refused = await asking().then(() => null, (error: unknown) => error);
  expect(refused, 'a page that did not arrive must not come back as the cautious answer').toBeInstanceOf(NotAsked);
  expect((refused as Error).message).toContain(question);
  expect((refused as Error).message).toContain('ERR_CONNECTION_RESET');
  expect((refused as Error).message, 'the call log belongs in the cause, not the sentence').not.toContain('Call log');
  expect(put, 'nothing is asked on a page that never arrived').toBe(0);

  // Not remembered: the same question is asked again, and this time put.
  expect(await asking()).toBe(true);
  expect(put).toBe(1);
  // The control. An answer is remembered, so a third asking loads nothing.
  expect(await asking()).toBe(true);
  expect(put).toBe(1);
  expect(loads).toBe(2);
});

test('a question that was put and threw is still answered with caution, and that is remembered', async () => {
  const question = fresh('put-and-threw');
  let put = 0;
  const page = pretend(async () => {});
  const asking = () => ask(page, question, () => onAPageOfItsOwn(page, async () => {
    put += 1;
    throw new Error('the engine would not');
  }), false);

  expect(await asking()).toBe(false);
  expect(await asking()).toBe(false);
  expect(put, 'an answer about the browser is asked for once').toBe(1);
  expect(wasSilent(page, question)).toBe(false);
});

test('a page slow to arrive does not use up the time the question was given', async () => {
  // Four hundred milliseconds to arrive and a quarter of a second to answer
  // in: over the deadline, had its clock started with the asking.
  const answered = fresh('slow-arrival');
  const slow = pretend(() => pause(400));
  expect(await ask(slow, answered, () => onAPageOfItsOwn(slow, async () => {
    await pause(20);
    return true;
  }), false, 250)).toBe(true);
  expect(wasSilent(slow, answered)).toBe(false);

  // The control. With the page there, a question that outlasts its deadline
  // is silence, as it always was.
  const unanswered = fresh('silence');
  const there = pretend(async () => {});
  expect(await ask(there, unanswered, () => onAPageOfItsOwn(there, async () => {
    await pause(600);
    return true;
  }), false, 250)).toBe(false);
  expect(wasSilent(there, unanswered)).toBe(true);
});

test('a waiting asker takes over when the one asking never got to ask', async () => {
  const question = fresh('take-over');
  const lost = pretend(async () => {
    await pause(500);
    throw new Error(RESET);
  });
  const found = pretend(async () => {});
  const began = Date.now();

  const first = ask(lost, question, () => onAPageOfItsOwn(lost, async () => true), false)
    .then(() => null, (error: unknown) => error);
  // The first holds the lock by now, as another worker would.
  await pause(50);
  const second = ask(found, question, () => onAPageOfItsOwn(found, async () => true), false);

  expect(await first).toBeInstanceOf(NotAsked);
  expect(await second, 'the waiter must ask for itself, not inherit a no').toBe(true);
  // Far inside what a waiter allows an asker that is still at it.
  expect(Date.now() - began).toBeLessThan(5_000);
});
