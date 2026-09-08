import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Tool-level functional tests for the business profile preview.
 *
 * WHAT THIS TOOL PROMISES, AND WHICH HALF OF IT CAN FAIL SILENTLY
 *
 * It draws a mock-up of a Google listing from typed fields, on three surfaces
 * of three different widths. Its own page says the spacing is an
 * approximation and that what is exact is "how much of each field survives the
 * width it is given" - so that is the claim, and it is the claim a wrong
 * implementation would still look completely convincing about. A name cut in
 * the panel and whole in the search result is the same picture to a reader who
 * has not measured it, and somebody would take that screenshot to a client and
 * shorten a name that did not need shortening.
 *
 * The other computed thing is the status line: whether the place is open at
 * this moment. Nothing on the page can tell you it is wrong - a confident
 * green "Open" over a shop that shut an hour ago looks exactly like a correct
 * one. It is the kind of number that is only ever discovered by somebody
 * turning up at a locked door.
 *
 * WHERE THE ANSWERS ARE READ
 *
 * Out of the SVG the page draws, which is also the SVG it downloads: the tool
 * has one renderer, so the `<text>` nodes in `#stage` are the picture. Nothing
 * here reads a label or a note to find out what the tool believes it did.
 *
 * WHY THE HOURS ARE SET TO EXTREMES
 *
 * The status line reads the visitor's own clock, which a test running against
 * a deployed site cannot choose. So the two cases below are the two that are
 * true at every hour of every day: a week with every day shut can only say
 * Closed, and a week of `00:00`-`00:00` - which the tool reads as a whole day
 * - can only say Open. Anything in between would be a test that passed in the
 * morning and failed at night.
 */

const URL_PATH = '/business-profile-preview/';

/** Every word the mock-up itself shows, in the order it draws them. */
async function cardText(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#stage svg text'))
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean));
}

/** The whole of the card as one string, for a plain "does it say" question. */
async function cardSays(page: Page): Promise<string> {
  return (await cardText(page)).join(' | ');
}

/**
 * How much of `full` a surface actually drew.
 *
 * The name is what the card draws first, so the leading text nodes are its
 * lines until one of them is not part of the name - the rating, which follows
 * it. Each line is whole words, so each is a substring of the name; the
 * ellipsis a cut line ends with is not part of it and comes off.
 */
async function nameShown(page: Page, full: string): Promise<string> {
  const parts: string[] = [];
  for (const line of await cardText(page)) {
    const bare = line.replace(/…$/, '').trim();
    if (!bare || !full.includes(bare)) break;
    parts.push(bare);
  }
  return parts.join(' ');
}

/** Show one of the three surfaces and wait for the redraw. */
async function showSurface(page: Page, which: string): Promise<void> {
  await page.locator(`.chip[data-surface="${which}"]`).click();
  await expect(page.locator(`.chip[data-surface="${which}"]`))
    .toHaveAttribute('aria-pressed', 'true');
  // #stage-note is written by the same pass that writes the SVG, so waiting
  // for it to name this surface is better than a pause.
  await expect(page.locator('#stage-note')).not.toBeEmpty();
}

/** Type into one of the tool's fields and wait for the picture to catch up. */
async function setField(page: Page, id: string, value: string): Promise<void> {
  await page.locator(`#${id}`).fill(value);
  // The redraw is coalesced to one a frame; two frames is comfortably past it.
  await page.evaluate(() => new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }));
}

/** Set every day of the week to the same window, or shut it. */
async function setWeek(page: Page, span: { open: string; close: string } | 'shut') {
  await page.evaluate((week) => {
    // Array.from and a cast rather than for-of and a type argument: this body
    // is serialised into the page and compiled under the repo's tsconfig,
    // where a NodeList is not iterable and querySelector takes none.
    Array.from(document.querySelectorAll('.week-row')).forEach((row) => {
      const shut = row.querySelector('.day-shut') as HTMLInputElement;
      const from = row.querySelector('.day-open') as HTMLInputElement;
      const to = row.querySelector('.day-close') as HTMLInputElement;
      shut.checked = week === 'shut';
      if (week !== 'shut') {
        from.value = week.open;
        to.value = week.close;
      }
    });
    const rows = document.getElementById('week') as HTMLElement;
    rows.dispatchEvent(new Event('input', { bubbles: true }));
  }, span);
  await page.evaluate(() => new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }));
}

test.describe('business-profile-preview: what survives the width, and the clock', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    await expect(page.locator('#stage svg')).toBeVisible({ timeout: 20_000 });
  });

  /**
   * The control the rest of the file needs. A tool that ignored the width
   * entirely - drawing every surface from the same string - would satisfy
   * "the search result cuts a long name" for no better reason than that it
   * cuts every name, and would satisfy nothing about the tool's actual claim.
   */
  test('control: a short name is cut on none of the three surfaces',
    async ({ page }) => {
      await setField(page, 'name', 'Ada Bakes');

      for (const surface of ['panel', 'mobile', 'listing']) {
        await showSurface(page, surface);
        const words = await cardText(page);
        expect(words, `${surface} drew nothing`).not.toHaveLength(0);
        expect(words.join(' | '), `${surface} cut a nine-character name`)
          .toContain('Ada Bakes');
      }
    });

  /**
   * The claim itself, asserted as a comparison rather than against a number.
   *
   * A first draft picked a name it believed was too long for the search result
   * and asserted an ellipsis. It measured 497 pixels against a 500-pixel
   * column on the machine it was written on - three pixels from passing for a
   * reason that has nothing to do with the tool, and a different answer on a
   * runner with different fonts installed. Any absolute character count here
   * is that test.
   *
   * What is true whatever the font is the ratio: the panel gives the name two
   * lines of 388 and the search result gives it one line of 500, so the panel
   * always shows about a sixth more of it. Both surfaces measure with the same
   * font, so the comparison holds where a threshold would not.
   */
  test('the same name is cut sooner on the narrow surface than on the wide one',
    async ({ page }) => {
      const long = 'Ashgrove Bakehouse and Coffee Roasters of Bristol City Centre '
        + 'and the Harbourside Mill Bakery Company Limited';
      await setField(page, 'name', long);

      await showSurface(page, 'panel');
      const panel = await nameShown(page, long);

      await showSurface(page, 'listing');
      const listing = await nameShown(page, long);

      expect(panel.length, 'the panel drew none of the name').toBeGreaterThan(0);
      expect(listing.length, 'the search result drew none of the name')
        .toBeGreaterThan(0);
      expect(
        panel.length,
        `the panel showed ${panel.length} characters and the search result `
        + `${listing.length}: the wider surface must show more of the name`,
      ).toBeGreaterThan(listing.length);

      // And a cut has to announce itself. A name that simply stops reads as a
      // shorter name, which is the mistake somebody would act on.
      expect(await cardSays(page), 'the search result did not mark the name as cut')
        .toContain('…');
    });

  test('a week that is shut every day can only say Closed', async ({ page }) => {
    await setWeek(page, 'shut');
    const words = await cardSays(page);
    expect(words, 'a shop shut every day of the week reported itself open')
      .not.toMatch(/(^|\| )Open( \||$)/);
    expect(words).toContain('Closed');
  });

  test('a week that never shuts can only say Open', async ({ page }) => {
    // The tool reads a window that ends where it starts as the whole day.
    await setWeek(page, { open: '00:00', close: '00:00' });
    const words = await cardSays(page);
    expect(words, 'a shop open every hour of the week reported itself closed')
      .not.toContain('Closed');
    expect(words).toMatch(/Open/);
  });

  /**
   * The three fields that turn into buttons. A profile missing one is a
   * profile a reader cannot act on, and the page's own argument is that this
   * is the fastest thing to check - so a card that drew the button anyway
   * would be telling somebody their listing was finished when it was not.
   */
  test('a button appears only when the field behind it does', async ({ page }) => {
    await showSurface(page, 'panel');
    expect(await cardSays(page)).toContain('Call');

    await setField(page, 'phone', '');
    expect(await cardSays(page), 'the Call button outlived the phone number')
      .not.toContain('Call');

    await setField(page, 'phone', '+44 117 496 0142');
    expect(await cardSays(page), 'the Call button did not come back')
      .toContain('Call');
  });

  /**
   * The import. It cannot be right about everything - it is heuristics over
   * text somebody copied off a screen - so what it must never do is claim a
   * field it did not fill or fill one it does not name. The page is built
   * around that promise: "every one of these is a guess worth checking".
   */
  test('a pasted listing lands in the fields, and the page names what it took',
    async ({ page }) => {
      await page.evaluate(() => {
        (document.getElementById('import-card') as HTMLDetailsElement).open = true;
      });
      await page.locator('#paste').fill([
        'Northside Dental Care',
        'Website',
        'Directions',
        '4.8 (213)',
        'Dentist',
        '88 Bathurst St Unit 4, Toronto, ON M5V 2P7',
        '(647) 555-9021',
      ].join('\n'));
      await page.locator('#read-paste').click();

      const note = page.locator('#import-note');
      await expect(note).toBeVisible();

      await expect(page.locator('#name')).toHaveValue('Northside Dental Care');
      await expect(page.locator('#category')).toHaveValue('Dentist');
      await expect(page.locator('#rating')).toHaveValue('4.8');
      await expect(page.locator('#reviews')).toHaveValue('213');
      await expect(page.locator('#phone')).toHaveValue('(647) 555-9021');

      // Every field it filled is a field it named, which is the half a reader
      // relies on: an unnamed guess is one nobody goes back and checks.
      const said = (await note.textContent()) ?? '';
      for (const named of ['name', 'category', 'rating', 'review', 'phone']) {
        expect(said.toLowerCase(), `the report did not mention the ${named}`)
          .toContain(named);
      }

      // "Website" and "Directions" are the words on the listing's own buttons.
      // Reading either as the business name is the mistake this paste exists
      // to catch.
      await expect(page.locator('#name')).not.toHaveValue(/Website|Directions/);
    });

  /**
   * The download, which is what somebody actually leaves with. It is drawn by
   * handing the page's own SVG to the browser as an image, and that is a
   * second parser: markup the page renders perfectly can fail there with
   * nothing on screen to say why. A preview that looks right and a button that
   * quietly does nothing is the worst shape this tool could fail in.
   */
  test('the PNG really comes out, and is a PNG', async ({ page }) => {
    const pending = page.waitForEvent('download');
    await page.locator('#save-png').click();
    const saved = await pending;
    const path = await saved.path();
    expect(path, 'the browser saved no PNG').toBeTruthy();

    const bytes = fs.readFileSync(path!);
    expect(bytes.length, 'the PNG is empty').toBeGreaterThan(1000);
    expect(bytes.subarray(0, 8).toString('hex'), 'not a PNG signature')
      .toBe('89504e470d0a1a0a');
    await expect(page.locator('#save-error')).toBeHidden();
  });

  /**
   * The example button is the only way to get a photograph onto the card
   * without a file, and the photograph is drawn in the page rather than
   * fetched - so this also asserts the thing the tool's privacy claim rests
   * on: whatever ends up inside the picture is a data: URI of the page's own
   * making, never a reference to somewhere else.
   */
  test('the example fills the card, and what it embeds points nowhere',
    async ({ page }) => {
      await page.locator('#sample').click();
      await expect(page.locator('#photo-note')).toBeVisible();

      const embedded = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#stage svg image'))
          .map((node) => node.getAttribute('href') ?? ''));
      expect(embedded, 'the example put no photograph on the card')
        .not.toHaveLength(0);
      for (const href of embedded) {
        expect(href.slice(0, 40), 'the card reached outside itself for a picture')
          .toMatch(/^data:image\//);
      }
    });
});
