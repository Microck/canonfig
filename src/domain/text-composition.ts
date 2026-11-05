/**
 * The append-local file format. The marked Source payload and the unmarked
 * local suffix have separate owners, even though the client reads one file.
 * Delimiter newlines belong to Canonfig; payload whitespace is never trimmed.
 */
export const sourceTextStart = "<!-- canonfig:source:start -->";
export const sourceTextEnd = "<!-- canonfig:source:end -->";

export type TextComposition =
  | { readonly kind: "unmanaged"; readonly local: string }
  | { readonly kind: "managed"; readonly source: string; readonly local: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const containsSourceMarker = (text: string): boolean =>
  text.includes(sourceTextStart) || text.includes(sourceTextEnd);

const nulIssue = "append-local requires text without NUL characters";
const markerIssue = "append-local Source text contains a reserved Canonfig marker";
const utf8Issue = "append-local requires UTF-8 text";

/** Publication validates text once, before it can become a signed payload. */
export const sourceTextIssue = (text: string): string | undefined => {
  if (text.includes("\0")) return nulIssue;
  if (decoder.decode(encoder.encode(text)) !== text) {
    return "append-local requires valid Unicode text";
  }
  return containsSourceMarker(text) ? markerIssue : undefined;
};

/** `sourceTextIssue` for authored bytes, which must also decode as UTF-8. */
export const sourceBytesIssue = (bytes: Uint8Array): string | undefined => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return utf8Issue;
  }
  return sourceTextIssue(text);
};

/**
 * `sourceBytesIssue` over a file read in chunks, so publication never holds
 * an authored file whole. The streaming decoder carries a UTF-8 sequence cut
 * between chunks, and the last characters of the previous chunk are scanned
 * again with the next one, so a marker cut between chunks is still found.
 * Strict UTF-8 decoding never yields a lone surrogate, so the Unicode check
 * of `sourceTextIssue` has nothing to find here. Invalid UTF-8 wins over the
 * other issues, as it does for whole bytes.
 */
export const sourceChunksIssue = async (chunks: AsyncIterable<Uint8Array>): Promise<string | undefined> => {
  const streaming = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // A marker cut between chunks leaves at most its length minus one characters before the cut.
  const carried = Math.max(sourceTextStart.length, sourceTextEnd.length) - 1;
  let previous = "";
  let nul = false;
  let marker = false;
  const scan = (text: string): void => {
    const window = previous + text;
    nul ||= text.includes("\0");
    marker ||= containsSourceMarker(window);
    previous = window.slice(-carried);
  };
  try {
    for await (const chunk of chunks) scan(streaming.decode(chunk, { stream: true }));
    scan(streaming.decode());
  } catch (cause) {
    // A fatal decoder reports invalid UTF-8 as a TypeError; read failures are not one.
    if (cause instanceof TypeError && "code" in cause && cause.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return utf8Issue;
    throw cause;
  }
  return nul ? nulIssue : marker ? markerIssue : undefined;
};

/**
 * Decode without replacing invalid UTF-8 or discarding a byte-order mark.
 * Partial, misplaced, and repeated delimiters are errors, not unmanaged text:
 * treating a damaged block as local text would duplicate old Source content.
 */
export const parseTextComposition = (bytes: Uint8Array): TextComposition => {
  const text = decoder.decode(bytes);
  if (text.includes("\0")) throw new Error("append-local target contains NUL characters");
  if (!containsSourceMarker(text)) return { kind: "unmanaged", local: text };

  const opening = `${sourceTextStart}\n`;
  const closing = `\n${sourceTextEnd}\n\n`;
  const end = text.indexOf(closing, opening.length);
  if (!text.startsWith(opening) || end < 0) {
    throw new Error("append-local Source markers are missing, misplaced, or malformed");
  }
  const source = text.slice(opening.length, end);
  const local = text.slice(end + closing.length);
  if (containsSourceMarker(source) || containsSourceMarker(local)) {
    throw new Error("append-local target contains repeated Source markers");
  }
  return { kind: "managed", source, local };
};

/**
 * First adoption retains the whole existing file, even when it equals Source.
 * Without an owned baseline, a diff cannot distinguish old shared from local text.
 * Once marked, only the explicit local suffix survives Source replacement.
 */
export const composeTextFile = (
  source: string,
  current?: TextComposition,
): Uint8Array => {
  const local = current?.local ?? "";
  return encoder.encode(`${sourceTextStart}\n${source}\n${sourceTextEnd}\n\n${local}`);
};
