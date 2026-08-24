/**
 * Putting real EXIF into a real JPEG, and reading a JPEG's structure back out.
 *
 * The EXIF viewer's headline claim is that removing metadata does not touch
 * the picture: "a stripped JPEG is byte-for-byte identical to its source from
 * the SOS marker onwards". Checking that needs a genuine JPEG with genuine
 * tags in it - in particular a genuine GPS position, since a coordinate
 * surviving a "remove all" is the failure that publishes somebody's address.
 *
 * The JPEG itself is made by a browser (see realJpeg in the spec): encoding
 * one here would mean writing a DCT and a Huffman coder, and a canvas already
 * has both. What this file adds is the APP1 segment a camera would have left
 * behind, and the segment walker the assertions read the result with.
 */

/** A latitude/longitude as EXIF stores it: degrees, minutes, seconds. */
export interface Dms {
  degrees: number;
  minutes: number;
  seconds: number;
  ref: 'N' | 'S' | 'E' | 'W';
}

/**
 * The position these fixtures carry, and the string the page should show for
 * it. readPosition() in the tool's report.js renders degrees to six decimal
 * places with the hemisphere from the separate ref tag, so this is what "Where
 * the photo was taken" has to say if the tags were read correctly.
 */
export const FIXTURE_LATITUDE: Dms = { degrees: 51, minutes: 30, seconds: 26.4, ref: 'N' };
export const FIXTURE_LONGITUDE: Dms = { degrees: 0, minutes: 7, seconds: 39.6, ref: 'W' };

const decimal = ({ degrees, minutes, seconds }: Dms): number => (
  degrees + minutes / 60 + seconds / 3600
);

export const FIXTURE_POSITION_TEXT = `${decimal(FIXTURE_LATITUDE).toFixed(6)}° N, `
  + `${decimal(FIXTURE_LONGITUDE).toFixed(6)}° W`;

export const FIXTURE_DESCRIPTION = 'QA fixture';
export const FIXTURE_MODEL = 'QA-CAM';

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/** Degrees/minutes/seconds as the three rationals EXIF wants, numerator over 10. */
function rationals(value: Dms): Array<[number, number]> {
  return [
    [Math.round(value.degrees), 1],
    [Math.round(value.minutes), 1],
    [Math.round(value.seconds * 10), 10],
  ];
}

/**
 * A TIFF block holding IFD0 (a description, a camera model, and a pointer to
 * the GPS IFD) and the GPS IFD itself.
 *
 * Offsets are counted from the start of this block, which is what the TIFF
 * header means by them, and every one of them is computed from the layout
 * below rather than written as a number - an EXIF block with a wrong offset
 * parses as damaged, and would make this fixture test the tool's error path
 * instead of its happy one.
 */
function exifTiff(): Buffer {
  const description = Buffer.from(`${FIXTURE_DESCRIPTION}\0`, 'latin1');
  const model = Buffer.from(`${FIXTURE_MODEL}\0`, 'latin1');

  const HEADER = 8;
  const ifd0Entries = 3;
  const ifd0End = HEADER + 2 + ifd0Entries * 12 + 4;

  const descriptionAt = ifd0End;
  const modelAt = descriptionAt + description.length;
  const gpsIfdAt = modelAt + model.length;

  const gpsEntries = 4;
  const gpsEnd = gpsIfdAt + 2 + gpsEntries * 12 + 4;
  const latitudeAt = gpsEnd;
  const longitudeAt = latitudeAt + 24;
  const total = longitudeAt + 24;

  const out = Buffer.alloc(total);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(HEADER, 4);

  /** One 12-byte IFD entry. Values of four bytes or fewer sit in the field itself. */
  const entry = (at: number, tag: number, type: number, count: number, write: (at: number) => void) => {
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    write(at + 8);
  };

  // ---- IFD0
  out.writeUInt16LE(ifd0Entries, HEADER);
  let at = HEADER + 2;
  entry(at, 0x010e, TYPE_ASCII, description.length, (v) => out.writeUInt32LE(descriptionAt, v));
  at += 12;
  entry(at, 0x0110, TYPE_ASCII, model.length, (v) => out.writeUInt32LE(modelAt, v));
  at += 12;
  entry(at, 0x8825, TYPE_LONG, 1, (v) => out.writeUInt32LE(gpsIfdAt, v));
  at += 12;
  out.writeUInt32LE(0, at); // no IFD1

  description.copy(out, descriptionAt);
  model.copy(out, modelAt);

  // ---- GPS IFD
  out.writeUInt16LE(gpsEntries, gpsIfdAt);
  at = gpsIfdAt + 2;
  entry(at, 0x0001, TYPE_ASCII, 2, (v) => out.write(`${FIXTURE_LATITUDE.ref}\0`, v, 'latin1'));
  at += 12;
  entry(at, 0x0002, TYPE_RATIONAL, 3, (v) => out.writeUInt32LE(latitudeAt, v));
  at += 12;
  entry(at, 0x0003, TYPE_ASCII, 2, (v) => out.write(`${FIXTURE_LONGITUDE.ref}\0`, v, 'latin1'));
  at += 12;
  entry(at, 0x0004, TYPE_RATIONAL, 3, (v) => out.writeUInt32LE(longitudeAt, v));
  at += 12;
  out.writeUInt32LE(0, at);

  rationals(FIXTURE_LATITUDE).forEach(([n, d], index) => {
    out.writeUInt32LE(n, latitudeAt + index * 8);
    out.writeUInt32LE(d, latitudeAt + index * 8 + 4);
  });
  rationals(FIXTURE_LONGITUDE).forEach(([n, d], index) => {
    out.writeUInt32LE(n, longitudeAt + index * 8);
    out.writeUInt32LE(d, longitudeAt + index * 8 + 4);
  });

  return out;
}

/** `Exif\0\0` - the identifier that marks an APP1 as EXIF rather than XMP. */
export const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');

/** The same JPEG with an EXIF APP1 segment - description, model and GPS - inserted after the SOI. */
export function withExifGps(jpeg: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('withExifGps was handed something that does not start like a JPEG');
  }

  const payload = Buffer.concat([EXIF_ID, exifTiff()]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2); // the length field counts itself

  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

export interface Segment {
  marker: number;
  /** Offset of the 0xFF that introduces the marker. */
  at: number;
  /** The segment's payload, absent for SOI/EOI and the scan. */
  data?: Buffer;
}

/**
 * Walk a JPEG's marker segments up to and including the SOS.
 *
 * Walked rather than searched: the bytes 0xFF 0xDA can occur inside an EXIF
 * block, so looking for the scan with indexOf would sometimes find a
 * coordinate instead - and would do it only for some fixtures, which is the
 * worst way for a test to be wrong.
 */
export function segments(bytes: Buffer): Segment[] {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');

  const out: Segment[] = [];
  let at = 2;

  while (at < bytes.length - 1) {
    if (bytes[at] !== 0xff) throw new Error(`lost segment structure at ${at}`);

    // Any number of 0xFF bytes may pad the gap before a marker.
    let markerAt = at;
    while (bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];

    if (marker === 0xd9) { // EOI
      out.push({ marker, at: markerAt - 1 });
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // standalone
      at = markerAt + 1;
      continue;
    }

    const length = bytes.readUInt16BE(markerAt + 1);
    out.push({
      marker,
      at: markerAt - 1,
      data: bytes.subarray(markerAt + 3, markerAt + 1 + length),
    });

    if (marker === 0xda) break; // the entropy-coded scan starts here
    at = markerAt + 1 + length;
  }

  return out;
}

/** Where the SOS marker starts - the point the tool promises not to change anything after. */
export function scanStart(bytes: Buffer): number {
  const sos = segments(bytes).find((s) => s.marker === 0xda);
  if (!sos) throw new Error('this JPEG has no scan in it');
  return sos.at;
}

/** Everything from the SOS marker to the end of the file. */
export function scan(bytes: Buffer): Buffer {
  return bytes.subarray(scanStart(bytes));
}

/** The APPn and COM segments in a file, by marker - what "metadata" means for a JPEG. */
export function metadataSegments(bytes: Buffer): Segment[] {
  return segments(bytes).filter((s) => (s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe);
}

/** Whether any APP1 in the file is an EXIF block. */
export function hasExif(bytes: Buffer): boolean {
  return metadataSegments(bytes).some(
    (s) => s.marker === 0xe1 && s.data?.subarray(0, EXIF_ID.length).equals(EXIF_ID),
  );
}
