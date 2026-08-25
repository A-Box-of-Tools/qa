/**
 * Writing a small DICOM file, so the viewer can be tested without anybody's
 * medical record.
 *
 * This is the one fixture where using a real file would be indefensible. A
 * scan's header carries, as the tool's own README lists, "the patient's name,
 * date of birth and hospital number, the accession number, the referring
 * doctor, the institution, the scanner's serial number, and a set of UIDs that
 * are perfect keys back into the archive that produced it". A synthetic one
 * carries invented versions of exactly those, which is what makes it useful:
 * the viewer's central claim is that it tells you what in the file identifies
 * the patient, and that can only be checked against identifiers whose values
 * are known in advance.
 *
 * Explicit VR little endian throughout - the transfer syntax every reader
 * supports - with uncompressed 16-bit greyscale pixels.
 */

/** The identifiers written into the fixture, so tests can look for them by value. */
export const FIXTURE_PATIENT = {
  name: 'QATEST^SYNTHETIC',
  id: 'QA-0001-SYNTHETIC',
  birthDate: '19700101',
  accession: 'ACC-QA-12345',
  referringPhysician: 'REFERRER^QA',
  institution: 'QA Test Hospital',
  studyUid: '1.2.826.0.1.3680043.10.1337.1',
  seriesUid: '1.2.826.0.1.3680043.10.1337.2',
  instanceUid: '1.2.826.0.1.3680043.10.1337.3',
} as const;

/** VRs whose length field is 4 bytes rather than 2. */
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

interface Element {
  group: number;
  element: number;
  vr: string;
  value: Buffer;
}

/** A DICOM string value: even length, padded with a space (or NUL for UI). */
function text(value: string, vr: string): Buffer {
  const pad = vr === 'UI' ? '\0' : ' ';
  return Buffer.from(value.length % 2 === 0 ? value : value + pad, 'latin1');
}

function encodeElement(item: Element): Buffer {
  const head = Buffer.alloc(LONG_VRS.has(item.vr) ? 12 : 8);
  head.writeUInt16LE(item.group, 0);
  head.writeUInt16LE(item.element, 2);
  head.write(item.vr, 4, 'latin1');

  if (LONG_VRS.has(item.vr)) {
    head.writeUInt16LE(0, 6); // reserved
    head.writeUInt32LE(item.value.length, 8);
  } else {
    head.writeUInt16LE(item.value.length, 6);
  }

  return Buffer.concat([head, item.value]);
}

const str = (group: number, element: number, vr: string, value: string): Element => (
  { group, element, vr, value: text(value, vr) }
);

const uint16 = (group: number, element: number, value: number): Element => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return { group, element, vr: 'US', value: buffer };
};

export interface DicomOptions {
  width?: number;
  height?: number;
  /** Leave the identifying elements out, for testing the "nothing here" case. */
  anonymous?: boolean;
  /** Instance number, so a series can be stacked in order. */
  instanceNumber?: number;
  /** Distinguishes the slices of one series. */
  instanceUidSuffix?: string;
}

/**
 * A single-frame greyscale DICOM.
 *
 * The picture is a gradient with a bright square in it, so a window/level
 * control has something to do and one slice is tellable from another.
 */
export function writeDicom(options: DicomOptions = {}): Buffer {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const anonymous = options.anonymous ?? false;

  const pixels = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inSquare = x > width / 4 && x < (width * 3) / 4
        && y > height / 4 && y < (height * 3) / 4;
      const value = inSquare ? 3000 : Math.round((x / width) * 1200);
      pixels.writeUInt16LE(value, (y * width + x) * 2);
    }
  }

  const instanceUid = FIXTURE_PATIENT.instanceUid
    + (options.instanceUidSuffix ? `.${options.instanceUidSuffix}` : '');

  const dataset: Element[] = [
    str(0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.7'), // SOP class: secondary capture
    str(0x0008, 0x0018, 'UI', instanceUid),
    str(0x0008, 0x0020, 'DA', '20240102'), // StudyDate
    str(0x0008, 0x0060, 'CS', 'OT'), // Modality
  ];

  if (!anonymous) {
    dataset.push(
      str(0x0008, 0x0050, 'SH', FIXTURE_PATIENT.accession),
      str(0x0008, 0x0080, 'LO', FIXTURE_PATIENT.institution),
      str(0x0008, 0x0090, 'PN', FIXTURE_PATIENT.referringPhysician),
      str(0x0010, 0x0010, 'PN', FIXTURE_PATIENT.name),
      str(0x0010, 0x0020, 'LO', FIXTURE_PATIENT.id),
      str(0x0010, 0x0030, 'DA', FIXTURE_PATIENT.birthDate),
    );
  }

  dataset.push(
    str(0x0020, 0x000d, 'UI', FIXTURE_PATIENT.studyUid),
    str(0x0020, 0x000e, 'UI', FIXTURE_PATIENT.seriesUid),
    str(0x0020, 0x0013, 'IS', String(options.instanceNumber ?? 1)),
    uint16(0x0028, 0x0002, 1), // SamplesPerPixel
    str(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    uint16(0x0028, 0x0010, height), // Rows
    uint16(0x0028, 0x0011, width), // Columns
    uint16(0x0028, 0x0100, 16), // BitsAllocated
    uint16(0x0028, 0x0101, 16), // BitsStored
    uint16(0x0028, 0x0102, 15), // HighBit
    uint16(0x0028, 0x0103, 0), // PixelRepresentation: unsigned
    str(0x0028, 0x1050, 'DS', '1500'), // WindowCenter
    str(0x0028, 0x1051, 'DS', '3000'), // WindowWidth
    str(0x0028, 0x0030, 'DS', '0.5\\0.5'), // PixelSpacing, in mm
    { group: 0x7fe0, element: 0x0010, vr: 'OW', value: pixels },
  );

  const body = Buffer.concat(dataset.map(encodeElement));

  // PS3.10's file meta group, which has to declare its own length first.
  const metaAfterLength: Element[] = [
    { group: 0x0002, element: 0x0001, vr: 'OB', value: Buffer.from([0x00, 0x01]) },
    str(0x0002, 0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.7'),
    str(0x0002, 0x0003, 'UI', instanceUid),
    str(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'), // explicit VR little endian
    str(0x0002, 0x0012, 'UI', '1.2.826.0.1.3680043.10.1337'),
  ];
  const meta = Buffer.concat(metaAfterLength.map(encodeElement));

  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(meta.length, 0);

  return Buffer.concat([
    Buffer.alloc(128), // preamble
    Buffer.from('DICM', 'latin1'),
    encodeElement({ group: 0x0002, element: 0x0000, vr: 'UL', value: groupLength }),
    meta,
    body,
  ]);
}

/** A series of slices that belong together, numbered in order. */
export function writeSeries(count: number, options: DicomOptions = {}): Buffer[] {
  return Array.from({ length: count }, (_, index) => writeDicom({
    ...options,
    instanceNumber: index + 1,
    instanceUidSuffix: String(index + 1),
  }));
}
