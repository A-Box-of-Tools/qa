import zlib from 'node:zlib';

/**
 * Building small PDFs, and reading PDFs back, so the PDF tools can be checked
 * against something other than themselves.
 *
 * The reading half exists because the merger writes modern PDFs: its objects
 * go into object streams and its cross-reference table is an XRef stream, both
 * Flate-compressed. Grepping the output for "/Type /Page" therefore finds
 * nothing at all, and a test built on that would pass whatever the tool
 * produced. This resolves the xref properly, unpacks the object streams, walks
 * the page tree and carries inherited attributes down it - which is also the
 * exact behaviour the merger's own README says the naive implementations get
 * wrong.
 */

/* ------------------------------------------------------------------ writing */

export interface FixturePage {
  /** Drawn on the page, and what the reader below reads back out. */
  label: string;
  width: number;
  height: number;
}

/**
 * A small, valid, deliberately old-fashioned PDF: uncompressed objects and a
 * classic xref table, so that a failure to read it is a failure in the tool
 * rather than an argument about this file.
 *
 * Each page carries its own /MediaBox and one line of text, which is how the
 * tests tell pages apart after they have been shuffled between documents.
 */
export function buildPdf(pages: FixturePage[]): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const objects: string[] = [];
  /** Reserve an object number; bodies are filled in below in the same order. */
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  const catalogId = add(''); // 1
  const pagesId = add(''); // 2
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids: number[] = [];
  for (const page of pages) {
    const stream = `BT /F1 18 Tf 20 ${Math.round(page.height / 2)} Td (${page.label}) Tj ET\n`;
    const contentsId = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R `
      + `/MediaBox [0 0 ${page.width} ${page.height}] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> `
      + `/Contents ${contentsId} 0 R >>`,
    );
    kids.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] `
    + `/Count ${kids.length} >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;

  objects.forEach((body, index) => {
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    offsets.push(at);
    at += chunk.length;
    parts.push(chunk);
  });

  const xrefAt = at;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;

  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

export interface FixtureImagePage {
  /** JPEG bytes, embedded with /DCTDecode - that is, handed to the decoder as they are. */
  jpeg: Buffer;
  /** The image's pixel size, which is also the page size here (one point per pixel). */
  width: number;
  height: number;
}

/**
 * A PDF whose pages are photographs - the "stack of photographs in a wrapper"
 * the compressor's inventory is supposed to recognise, as opposed to the text
 * documents buildPdf makes.
 *
 * Assembled from Buffers rather than a string, because a JPEG is binary and
 * latin1 round-tripping it through a string is the kind of thing that works
 * until one byte is 0x80.
 */
export function buildImagePdf(pages: FixtureImagePage[]): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const bodies: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    bodies.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return bodies.length;
  };

  const catalogId = add('');
  const pagesId = add('');
  const kids: number[] = [];

  for (const page of pages) {
    const imageId = add(Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode `
        + `/Length ${page.jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      page.jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]));

    const draw = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q\n`;
    const contentsId = add(`<< /Length ${draw.length} >>\nstream\n${draw}endstream`);

    kids.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R `
      + `/MediaBox [0 0 ${page.width} ${page.height}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> `
      + `/Contents ${contentsId} 0 R >>`,
    ));
  }

  bodies[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
  bodies[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;

  bodies.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(at);
    at += chunk.length;
    parts.push(chunk);
  });

  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root ${catalogId} 0 R >>\n`
    + `startxref\n${at}\n%%EOF\n`;

  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ reading */

interface RawObject {
  /** The object's dictionary and any trailing content, as text. */
  body: string;
  /** The bytes of its stream, if it has one, already un-Flated where possible. */
  stream?: Buffer;
}

const latin1 = (bytes: Buffer): string => bytes.toString('latin1');

/** The raw token following `/Key` in a dictionary - a number, a name, a reference or an array. */
export function dictValue(body: string, key: string): string | null {
  const at = body.indexOf(`/${key}`);
  if (at === -1) return null;

  let rest = body.slice(at + key.length + 1).trimStart();
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    return end === -1 ? null : rest.slice(0, end + 1);
  }
  if (rest.startsWith('<<')) {
    // Balance the nesting so a nested dictionary comes back whole.
    let depth = 0;
    for (let i = 0; i < rest.length - 1; i += 1) {
      if (rest[i] === '<' && rest[i + 1] === '<') { depth += 1; i += 1; } else if (rest[i] === '>' && rest[i + 1] === '>') {
        depth -= 1;
        i += 1;
        if (depth === 0) return rest.slice(0, i + 1);
      }
    }
    return null;
  }
  const match = rest.match(/^(\d+\s+\d+\s+R|\/[^\s/[\]<>()]+|-?[\d.]+|true|false|null)/);
  return match ? match[1] : null;
}

/** `12 0 R` -> 12 */
const refTarget = (token: string | null): number | null => {
  const match = token?.match(/^(\d+)\s+\d+\s+R$/);
  return match ? Number(match[1]) : null;
};

function inflateIfNeeded(body: string, raw: Buffer): Buffer {
  if (!/\/FlateDecode/.test(body)) return raw;
  try {
    return zlib.inflateSync(raw);
  } catch {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return raw;
    }
  }
}

/** Pull `N 0 obj ... endobj` out of the file at a byte offset. */
function objectAt(bytes: Buffer, offset: number): RawObject | null {
  const head = latin1(bytes.subarray(offset, Math.min(offset + 4096, bytes.length)));
  if (!/^\s*\d+\s+\d+\s+obj/.test(head)) return null;

  const streamAt = bytes.indexOf('stream', offset);
  const endObj = bytes.indexOf('endobj', offset);

  if (streamAt !== -1 && (endObj === -1 || streamAt < endObj)) {
    const body = latin1(bytes.subarray(offset, streamAt));
    let start = streamAt + 'stream'.length;
    if (bytes[start] === 0x0d) start += 1;
    if (bytes[start] === 0x0a) start += 1;

    const lengthToken = dictValue(body, 'Length');
    let end: number;
    const declared = Number(lengthToken);
    if (lengthToken && Number.isFinite(declared) && !/R$/.test(lengthToken)) {
      end = start + declared;
    } else {
      end = bytes.indexOf('endstream', start);
    }
    return { body, stream: inflateIfNeeded(body, bytes.subarray(start, end)) };
  }

  return { body: latin1(bytes.subarray(offset, endObj === -1 ? bytes.length : endObj)) };
}

/**
 * Every object in the file, by number.
 *
 * Both cross-reference forms are handled, because the fixtures above use the
 * classic table and the merger writes the stream form.
 */
export function readObjects(bytes: Buffer): Map<number, RawObject> {
  const out = new Map<number, RawObject>();

  // Objects at a byte offset, found directly. This alone covers the classic
  // form and every stream object in the modern one, since a stream can never
  // live inside an object stream.
  const direct = /(?:^|[\r\n>\s])(\d+)\s+0\s+obj\b/g;
  const text = latin1(bytes);
  let match = direct.exec(text);
  while (match) {
    const at = match.index + match[0].length - `${match[1]} 0 obj`.length;
    const object = objectAt(bytes, at);
    if (object) out.set(Number(match[1]), object);
    match = direct.exec(text);
  }

  // Then unpack any object streams, whose contents are not visible above.
  for (const [, object] of [...out]) {
    if (!/\/Type\s*\/ObjStm/.test(object.body) || !object.stream) continue;

    const count = Number(dictValue(object.body, 'N'));
    const first = Number(dictValue(object.body, 'First'));
    if (!Number.isFinite(count) || !Number.isFinite(first)) continue;

    const header = latin1(object.stream.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i += 1) {
      const number = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(number) || !Number.isFinite(offset)) continue;
      const next = i + 1 < count ? header[(i + 1) * 2 + 1] : object.stream.length - first;
      out.set(number, {
        body: latin1(object.stream.subarray(first + offset, first + next)),
      });
    }
  }

  return out;
}

export interface PdfPage {
  /** [x0, y0, x1, y1], carried down the page tree if the leaf does not have one. */
  mediaBox: number[] | null;
  /** The strings drawn by the page's content stream, in order. */
  text: string[];
}

/**
 * The pages of a PDF, in document order, each with the attributes it actually
 * ends up with.
 *
 * /MediaBox is inherited, so a page that does not carry one takes the nearest
 * ancestor's - which is precisely what the merger has to write onto each copy
 * explicitly, because its new parent is a flat node shared between documents
 * and cannot carry anybody's.
 */
export function readPages(bytes: Buffer): PdfPage[] {
  const objects = readObjects(bytes);

  let rootId: number | null = null;
  const trailer = latin1(bytes).lastIndexOf('trailer');
  if (trailer !== -1) rootId = refTarget(dictValue(latin1(bytes).slice(trailer), 'Root'));
  if (rootId === null) {
    for (const [id, object] of objects) {
      if (/\/Type\s*\/Catalog/.test(object.body)) { rootId = id; break; }
      const root = refTarget(dictValue(object.body, 'Root'));
      if (root !== null) rootId = root;
    }
  }

  const catalog = rootId === null ? null : objects.get(rootId);
  const pagesId = catalog ? refTarget(dictValue(catalog.body, 'Pages')) : null;
  if (pagesId === null) return [];

  const pages: PdfPage[] = [];
  const seen = new Set<number>();

  const numbers = (token: string | null): number[] | null => {
    if (!token) return null;
    const found = token.match(/-?[\d.]+/g);
    return found ? found.map(Number) : null;
  };

  const walk = (id: number, inheritedBox: number[] | null): void => {
    if (seen.has(id)) return; // a malformed tree must not hang the test
    seen.add(id);

    const node = objects.get(id);
    if (!node) return;

    const box = numbers(dictValue(node.body, 'MediaBox')) ?? inheritedBox;

    if (/\/Type\s*\/Page\b/.test(node.body) && !/\/Type\s*\/Pages\b/.test(node.body)) {
      pages.push({ mediaBox: box, text: contentText(objects, node) });
      return;
    }

    const kids = dictValue(node.body, 'Kids');
    for (const ref of kids?.match(/(\d+)\s+\d+\s+R/g) ?? []) {
      walk(Number(ref.match(/^(\d+)/)![1]), box);
    }
  };

  walk(pagesId, null);
  return pages;
}

/** The literal strings a page's content stream draws, in order. */
function contentText(objects: Map<number, RawObject>, page: RawObject): string[] {
  const token = dictValue(page.body, 'Contents');
  const ids = token?.match(/(\d+)\s+\d+\s+R/g)?.map((r) => Number(r.match(/^(\d+)/)![1])) ?? [];

  let joined = '';
  for (const id of ids) {
    const stream = objects.get(id)?.stream;
    if (stream) joined += latin1(stream);
  }

  return [...joined.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((m) => m[1]);
}

/** Every string drawn anywhere in the document, in page order. */
export function allText(bytes: Buffer): string[] {
  return readPages(bytes).flatMap((page) => page.text);
}

export interface EmbeddedImage {
  width: number;
  height: number;
  /** /DCTDecode, /FlateDecode, /JPXDecode ... - how the bytes are stored. */
  filter: string | null;
  /**
   * The stream exactly as it sits in the file. For a DCTDecode image these are
   * JPEG bytes, and readObjects deliberately leaves them alone - only Flate is
   * unpacked - so they can be compared with the JPEG that went in.
   */
  data: Buffer;
}

/**
 * The image XObjects in a document.
 *
 * This is what makes "the JPEG was copied in, not re-encoded" checkable: if
 * the bytes here equal the bytes of the file that was chosen, nothing decoded
 * and recompressed it on the way in.
 */
export function readImages(bytes: Buffer): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];

  for (const [, object] of readObjects(bytes)) {
    if (!/\/Subtype\s*\/Image/.test(object.body) || !object.stream) continue;
    out.push({
      width: Number(dictValue(object.body, 'Width')),
      height: Number(dictValue(object.body, 'Height')),
      filter: dictValue(object.body, 'Filter'),
      data: object.stream,
    });
  }

  return out;
}
