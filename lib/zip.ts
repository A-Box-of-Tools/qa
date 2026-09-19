import zlib from 'node:zlib';

/**
 * What is inside a zip, read from its central directory.
 *
 * The batch converters offer every result as one zip, and what matters about
 * it is the thing that fails quietly: two files of the same name from two
 * folders are one entry in most unzippers, the second replacing the first. The
 * page promises they are kept apart, so the names and the bytes are read here
 * rather than taken from the list on the page.
 *
 * The directory at the end of the file is the authority on what a zip holds -
 * it is what an unzipper reads - so this starts there and follows each entry
 * back to its data. Stored and deflated entries are both opened; anything else
 * is an error, because nothing on the site writes it.
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export function zipEntries(bytes: Buffer): ZipEntry[] {
  // The end record is the last thing in the file but for a comment of up to
  // 65,535 bytes, so it is looked for from the back.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new Error('not a zip: no end-of-directory record');

  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error('the zip directory is damaged');

    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    if (bytes.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`${name}: no local header`);
    // The local header repeats the name and carries an extra field of its
    // own, whose length need not match the directory's.
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + packed);

    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`${name}: compression method ${method} is not one this reads`);

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
