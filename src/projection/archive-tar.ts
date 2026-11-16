import { Buffer } from "node:buffer";

/** The single tar dialect used by exports and backups: regular files and PAX paths. */
export interface TarFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}
export interface TarSource extends TarFile {
  readonly content: Uint8Array | AsyncIterable<Uint8Array>;
}

const octal = (header: Buffer, offset: number, length: number, value: number): void => {
  const text = value.toString(8);
  if (text.length >= length) throw new Error("Archive file exceeds the tar size limit");
  header.write(`${text.padStart(length - 1, "0")}\0`, offset, length, "ascii");
};
const headerFor = (name: string, size: number, mode: number, type: "0" | "x"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, mode & 0o777);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  // Equal inputs have equal bytes, independent of filesystem timestamps.
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
};
const padding = (size: number): Buffer => Buffer.alloc((512 - size % 512) % 512);

/** The largest size the 11-digit octal ustar field holds (8 GiB - 1); larger entries carry a PAX `size` record. */
const USTAR_SIZE_LIMIT = 0o77777777777;

/** One PAX record, `<length> <key>=<value>\n`, where length counts its own digits. */
const paxRecord = (key: string, value: string): string => {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 3;
  while (length !== Buffer.byteLength(payload) + String(length).length + 1) {
    length = Buffer.byteLength(payload) + String(length).length + 1;
  }
  return `${length} ${payload}`;
};

/** Stream the same canonical headers for in-memory exports and file-backed backups. */
export async function* encodeTar(files: ReadonlyArray<TarSource>): AsyncGenerator<Uint8Array> {
  for (const [index, file] of files.entries()) {
    const large = file.size > USTAR_SIZE_LIMIT;
    const record = Buffer.from(paxRecord("path", file.path) + (large ? paxRecord("size", String(file.size)) : ""));
    yield headerFor(`PaxHeaders/${index}`, record.length, 0o644, "x");
    yield record;
    yield padding(record.length);
    // PAX readers take the size record over the header field, which stays 0 when the size doesn't fit it.
    yield headerFor(`file-${index}`, large ? 0 : file.size, file.mode, "0");
    let size = 0;
    const chunks = file.content instanceof Uint8Array ? [file.content] : file.content;
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > file.size) throw new Error("Archive input grew during capture");
      yield chunk;
    }
    if (size !== file.size) throw new Error("Archive input changed during capture");
    yield padding(size);
  }
  yield Buffer.alloc(1024);
}

class TarReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array();
  private position = 0;
  private received = 0;
  constructor(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, private readonly maximumBytes: number) {
    this.iterator = (async function*() { yield* input; })()[Symbol.asyncIterator]();
  }
  private async available(): Promise<boolean> {
    while (this.position === this.buffer.length) {
      const next = await this.iterator.next();
      if (next.done === true) return false;
      this.received += next.value.length;
      if (this.received > this.maximumBytes) throw new Error("Archive exceeds the configured unpacked size limit");
      this.buffer = next.value;
      this.position = 0;
    }
    return true;
  }
  async *chunks(size: number): AsyncGenerator<Uint8Array> {
    while (size > 0) {
      if (!await this.available()) throw new Error("Archive ends inside an entry");
      const count = Math.min(size, this.buffer.length - this.position);
      const chunk = this.buffer.subarray(this.position, this.position + count);
      this.position += count;
      size -= count;
      yield chunk;
    }
  }
  async bytes(size: number): Promise<Buffer> {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    for await (const chunk of this.chunks(size)) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async finish(): Promise<void> {
    const second = await this.bytes(512);
    if (second.some(byte => byte !== 0)) throw new Error("Archive has no second end marker");
    while (await this.available()) {
      if (this.buffer.subarray(this.position).some(byte => byte !== 0)) throw new Error("Archive holds data after its end marker");
      this.position = this.buffer.length;
    }
  }
  async close(): Promise<void> { await this.iterator.return?.(); }
}

const readOctal = (header: Buffer, offset: number, length: number): number => {
  const text = header.subarray(offset, offset + length).toString("latin1").replace(/^ +/u, "").replace(/[\0 ]+$/u, "");
  const value = /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new Error("Archive has an invalid numeric header field");
  return value;
};
const field = (header: Buffer, offset: number, length: number): string => {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end < 0 ? length : end));
};
/** The extended header Canonfig writes: a path record, then a size record only when the size exceeds ustar's field. */
interface PaxHeader { readonly path: string; readonly size?: number }
const paxHeader = (body: Buffer): PaxHeader => {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString("ascii"));
    if (space <= offset || !Number.isSafeInteger(length) || offset + length > body.length || body[offset + length - 1] !== 0x0a) {
      throw new Error("Archive has a malformed extended header");
    }
    const record = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    if (equals < 1 || fields.has(key) || (key !== "path" && key !== "size") || (key === "size" && fields.size !== 1)) {
      throw new Error("Archive extended headers may contain only a path field and an optional size field");
    }
    fields.set(key, record.slice(equals + 1));
    offset += length;
  }
  const path = fields.get("path");
  if (path === undefined) throw new Error("Archive extended headers may contain only a path field and an optional size field");
  const sizeText = fields.get("size");
  if (sizeText === undefined) return { path };
  const size = /^[0-9]+$/u.test(sizeText) ? Number(sizeText) : Number.NaN;
  if (!Number.isSafeInteger(size) || size <= USTAR_SIZE_LIMIT) throw new Error("Archive has an invalid extended size");
  return { path, size };
};

/** Consume each body completely before advancing. Nothing outside the manifest may ride along. */
export const decodeTar = async (
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  consume: (file: TarFile, content: AsyncIterable<Uint8Array>) => Promise<void>,
  limits: { readonly bytes: number; readonly files: number },
): Promise<void> => {
  const reader = new TarReader(input, limits.bytes);
  let pax: PaxHeader | undefined;
  let count = 0;
  try {
    for (;;) {
      const header = await reader.bytes(512);
      if (header.every(byte => byte === 0)) {
        if (pax !== undefined) throw new Error("Archive ends after an extended header");
        await reader.finish();
        return;
      }
      let sum = 0;
      for (const [index, byte] of header.entries()) sum += index >= 148 && index < 156 ? 32 : byte;
      if (readOctal(header, 148, 8) !== sum) throw new Error("Archive has a damaged entry header");
      if (header.subarray(257, 263).toString("latin1") !== "ustar\0") throw new Error("Archive is not POSIX tar");
      const headerSize = readOctal(header, 124, 12);
      const type = header[156];
      if (type === 120) {
        if (pax !== undefined || headerSize > 2048) throw new Error("Archive has an invalid extended header");
        pax = paxHeader(await reader.bytes(headerSize));
        const pad = await reader.bytes(padding(headerSize).length);
        if (pad.some(byte => byte !== 0)) throw new Error("Archive holds nonzero entry padding");
        continue;
      }
      if (type !== 48 && type !== 0) throw new Error("Archive holds a link, directory, device or unsupported entry type");
      const mode = readOctal(header, 100, 8);
      if (mode > 0o777) throw new Error("Archive holds special permission bits");
      const prefix = field(header, 345, 155);
      // A PAX size replaces the header field only for entries too large for it, and only with a zero field.
      if (pax?.size !== undefined && headerSize !== 0) throw new Error("Archive has conflicting entry sizes");
      const size = pax?.size ?? headerSize;
      const name = pax?.path ?? `${prefix.length === 0 ? "" : `${prefix}/`}${field(header, 0, 100)}`;
      pax = undefined;
      count += 1;
      if (count > limits.files) throw new Error("Archive exceeds the configured file count limit");
      let consumed = 0;
      const content = (async function*() {
        for await (const chunk of reader.chunks(size)) { consumed += chunk.length; yield chunk; }
      })();
      await consume({ path: name, mode, size }, content);
      if (consumed !== size) throw new Error("Archive consumer did not read an entire entry");
      const pad = await reader.bytes(padding(size).length);
      if (pad.some(byte => byte !== 0)) throw new Error("Archive holds nonzero entry padding");
    }
  } finally {
    await reader.close();
  }
};
