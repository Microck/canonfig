export const tarBlockBytes = 512;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const tarString = (
  header: Uint8Array,
  offset: number,
  length: number,
): string => {
  const end = header.subarray(offset, offset + length).indexOf(0);
  const value = header.subarray(
    offset,
    offset + (end < 0 ? length : end),
  );
  return textDecoder.decode(value);
};

export const tarOctal = (
  header: Uint8Array,
  offset: number,
  length: number,
): number | undefined => {
  const raw = tarString(header, offset, length).replace(/^\s+|\s+$/gu, "");
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) return undefined;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) ? value : undefined;
};

export const tarChecksumValid = (header: Uint8Array): boolean => {
  const expected = tarOctal(header, 148, 8);
  if (expected === undefined) return false;
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return actual === expected;
};
