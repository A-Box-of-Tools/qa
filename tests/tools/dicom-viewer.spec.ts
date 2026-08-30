import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_PATIENT, writeDicom, writeSeries } from '../../lib/dicom';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the DICOM Viewer.
 *
 * The README calls this "the sharpest version of the site's promise", and it
 * is right: every other page here handles a holiday photograph or an invoice,
 * and this one handles a file that is a person's medical record with a picture
 * inside it. The header carries the patient's name, date of birth and hospital
 * number, the accession number, the referring doctor, the institution, and
 * UIDs that are perfect keys back into the archive that produced the scan.
 *
 * No real scan is used here and none should be. lib/dicom.ts writes a
 * synthetic one carrying invented versions of exactly those identifiers, which
 * is what makes the central claim checkable at all: a panel that lists what in
 * the file identifies the patient can only be tested against identifiers whose
 * values are known in advance.
 *
 * The claim the README is proudest of is the one worth testing hardest: "the
 * mistake people make is not leaving the name in - it is taking the name out
 * and thinking that was the job". So a file with every name stripped still has
 * to be reported as identifying, because its UIDs still lead home.
 */

const URL_PATH = '/dicom-viewer/';

async function open(page: Page, bytes: Buffer, name = 'scan.dcm'): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'application/dicom', buffer: bytes,
  });
  await expect(page.locator('#load-error')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#identity-card')).toBeVisible({ timeout: 30_000 });
}

/** What the identity panel says, as one string. */
async function identity(page: Page): Promise<string> {
  const list = ((await page.locator('#identity').textContent()) ?? '');
  const extra = ((await page.locator('#identity-extra').textContent()) ?? '');
  return `${list} ${extra}`.replace(/\s+/g, ' ');
}

test.describe('dicom-viewer: reading a scan', () => {
  test('control: the fixture is a DICOM this viewer can open', async ({ page }) => {
    // Every assertion below rests on the file being read at all. A fixture the
    // viewer rejected would make an empty identity panel look like a bug in
    // the panel.
    const bytes = writeDicom();
    expect(bytes.subarray(128, 132).toString('latin1'), 'no DICM magic').toBe('DICM');

    await open(page, bytes);

    await expect(page.locator('#viewport-fail')).toBeHidden();
    const canvas = await page.locator('#canvas').evaluate(
      (el) => `${(el as HTMLCanvasElement).width}x${(el as HTMLCanvasElement).height}`,
    );
    expect(canvas, 'the picture was not decoded').toBe('64x64');
  });

  test('the header is listed, tag by tag', async ({ page }) => {
    await open(page, writeDicom());
    await expect(page.locator('#tags-card')).toBeVisible();
    // The fixture writes about thirty elements; the exact count is the tool's
    // business, but an empty table would mean it read nothing.
    expect(await page.locator('#tag-rows tr').count()).toBeGreaterThan(10);
  });
});

test.describe('dicom-viewer: what identifies the patient', () => {
  test('every identifier in the file is named on the page', async ({ page }) => {
    // The panel the tool exists for. Each of these was written into the
    // fixture, so each has to come back out.
    await open(page, writeDicom());
    const said = await identity(page);

    expect(said, 'the patient ID is not listed').toContain(FIXTURE_PATIENT.id);
    expect(said, 'the accession number is not listed').toContain(FIXTURE_PATIENT.accession);
    expect(said, 'the institution is not listed').toContain(FIXTURE_PATIENT.institution);

    // A person's name is shown the way people read it rather than the way
    // DICOM stores it - QATEST^SYNTHETIC becomes SYNTHETIC QATEST - so both
    // halves are checked rather than the raw caret form.
    expect(said, 'the patient name is not listed').toContain('QATEST');
    expect(said).toContain('SYNTHETIC');

    // The birth date is reformatted too: 19700101 reads as 1 January 1970.
    expect(said, 'the birth date is not listed').toContain('1970');
  });

  test('a file with the names taken out is still not anonymous', async ({ page }) => {
    // The claim the README makes most forcefully, and the one a viewer that
    // only looked for a name would fail: the UIDs are still perfect keys into
    // the archive that made the file, so a stripped dataset has to be reported
    // as identifying rather than clean.
    await open(page, writeDicom({ anonymous: true }), 'stripped.dcm');
    const said = await identity(page);

    // Nothing that names a person...
    expect(said).not.toContain(FIXTURE_PATIENT.id);
    expect(said).not.toContain('QATEST');

    // ...but the file still carries identifiers of its own, and the page has
    // to say so rather than calling it clean.
    expect(said.toLowerCase(), 'a stripped file was not reported as still identifying')
      .toMatch(/uid|identifier|archive|key/);
  });

  test('the identifiers it reports are the ones actually in the file', async ({ page }) => {
    // The other direction: a panel that listed every tag PS3.15 mentions,
    // present or not, would be a checklist rather than a reading of this file.
    await open(page, writeDicom({ anonymous: true }), 'stripped.dcm');
    const said = await identity(page);

    expect(said, 'an identifier absent from the file was reported as present')
      .not.toContain(FIXTURE_PATIENT.accession);
    expect(said).not.toContain(FIXTURE_PATIENT.institution);
  });
});

test.describe('dicom-viewer: the picture', () => {
  test('a folder of slices is stacked back into one series', async ({ page }) => {
    // A series arrives as a directory of single-slice files, and putting them
    // back in order is most of what a viewer is for.
    test.setTimeout(120_000);
    const slices = writeSeries(5);

    await page.goto(URL_PATH);
    await page.locator('#file-input').setInputFiles(slices.map((buffer, index) => ({
      name: `slice-${index + 1}.dcm`,
      mimeType: 'application/dicom',
      buffer,
    })));

    await expect(page.locator('#identity-card')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#scrub-row')).toBeVisible({ timeout: 60_000 });

    // Five slices means the scrubber runs 0..4.
    await expect(page.locator('#scrub')).toHaveAttribute('max', '4');
  });

  test('the window and level control changes what is drawn', async ({ page }) => {
    // A scan is 16-bit and a screen is not, so which values are visible is a
    // choice the reader makes. A control that changed nothing would be the
    // difference between seeing a finding and not.
    await open(page, writeDicom());

    const sample = () => page.locator('#canvas').evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let total = 0;
      for (let at = 0; at < data.length; at += 4) total += data[at];
      return Math.round(total / (data.length / 4));
    });

    const before = await sample();

    // The window is two number boxes - a centre and a width - not a slider.
    // Narrowing the width hard is the change a reader makes to pull a finding
    // out of flat-looking tissue.
    await page.locator('#width').fill('200');
    await page.locator('#width').blur();
    await page.locator('#center').fill('2800');
    await page.locator('#center').blur();

    await expect.poll(async () => sample(), { timeout: 15_000 }).not.toBe(before);
  });
});

test.describe('dicom-viewer: the promise', () => {
  test('the scan never leaves the page', async ({ page }) => {
    // The strongest version of this claim on the site. The file is somebody's
    // medical record, and the identifiers in it are the point of the panel -
    // so both the pixels and the names are checked.
    test.setTimeout(120_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = writeDicom();
    await page.locator('#file-input').setInputFiles({
      name: 'patient.dcm', mimeType: 'application/dicom', buffer: bytes,
    });
    await expect(page.locator('#identity-card')).toBeVisible({ timeout: 30_000 });
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the patient name was sent').not.toContain('QATEST');
      expect(entry, 'the patient ID was sent').not.toContain(FIXTURE_PATIENT.id);
      expect(entry, 'a UID was sent').not.toContain(FIXTURE_PATIENT.studyUid);
      expect(entry, 'the file was sent')
        .not.toContain(bytes.toString('base64').slice(300, 360));
    }
  });

  test('it offers no way to write a DICOM back out', async ({ page }) => {
    // The README is explicit that this tool only reads, because "a viewer that
    // offered to anonymise would be making a promise that needs a much higher
    // bar than a viewer does". The frame can be saved as a PNG; the scan
    // cannot be saved as a scan.
    await open(page, writeDicom());

    await expect(page.locator('#save-frame')).toBeVisible();
    const downloads = await page.locator('[download]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('download') ?? ''),
    );
    for (const name of downloads) {
      expect(name.toLowerCase(), 'something offers to write a DICOM file')
        .not.toMatch(/\.dcm$/);
    }
  });
});
