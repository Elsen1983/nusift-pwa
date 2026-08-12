export const STATIC_RESPONSE_MAX_BYTES = 2_000_000;
export const CHARSET_SNIFF_MAX_BYTES = 4_096;

type DocumentKind = "html" | "xml" | "text";
type CharsetSource = "bom" | "http" | "xml" | "html" | "default" | "utf8_recovery";

export type DecodedResponseText = {
  text: string;
  byteLength: number;
  charset: string;
  charsetSource: CharsetSource;
  hadReplacement: boolean;
  declarationConflict: boolean;
  truncated: boolean;
};

export class UnsupportedResponseCharsetError extends Error {
  constructor(readonly charsetLabel: string) {
    super(`Unsupported response charset: ${charsetLabel.slice(0, 40)}`);
    this.name = "UnsupportedResponseCharsetError";
  }
}

export class ResponseBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Response body exceeds ${limitBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

const LABEL_ALIASES: Readonly<Record<string, string>> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "utf-16": "utf-16le",
  utf16: "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  "windows-1250": "windows-1250",
  cp1250: "windows-1250",
  "iso-8859-2": "iso-8859-2",
  latin2: "iso-8859-2",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
};

const normalizeLabel = (value: string): string => {
  const label = value.trim().toLowerCase().replace(/^['"]|['"]$/g, "");
  const normalized = LABEL_ALIASES[label];
  if (!normalized) throw new UnsupportedResponseCharsetError(label || "empty");
  return normalized;
};

const headerValue = (response: Response, name: string): string | null => {
  const headers = response.headers as Headers & Record<string, unknown>;
  if (typeof headers?.get === "function") return headers.get(name);
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key && typeof headers[key] === "string" ? headers[key] as string : null;
};

const charsetFromContentType = (contentType: string | null): string | null => {
  const match = contentType?.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
};

const bom = (bytes: Uint8Array): { charset: string; length: number } | null => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: "utf-8", length: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: "utf-16le", length: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: "utf-16be", length: 2 };
  return null;
};

const sniffDeclaration = (bytes: Uint8Array, kind: DocumentKind): string | null => {
  if (kind === "text") return null;
  const sample = new TextDecoder("windows-1252").decode(bytes.subarray(0, CHARSET_SNIFF_MAX_BYTES));
  if (kind === "xml") {
    return sample.match(/^\s*<\?xml\b[^>]{0,300}?encoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
  }
  return sample.match(/<meta\b[^>]{0,500}?charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1]
    ?? sample.match(/<meta\b[^>]{0,700}?http-equiv\s*=\s*["']?content-type["']?[^>]*?content\s*=\s*["'][^"']*?charset\s*=\s*([^\s;"']+)/i)?.[1]
    ?? null;
};

const isSingleByteLegacyCharset = (charset: string): boolean =>
  charset === "windows-1250" || charset === "windows-1252" || charset === "iso-8859-2";

const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

// A publisher can serve UTF-8 bytes with an obsolete Latin/Windows charset
// header. Only override that declaration when its decoded output proves it
// produced the common UTF-8-as-single-byte mojibake sequences.
const hasUtf8Mojibake = (text: string): boolean => /(?:Ã[\u0080-\u00bf]|Å[\u0080-\u00bf\u2018\u2019])/.test(text);

const readBoundedBytes = async (
  response: Response,
  limitBytes: number,
  overflow: "reject" | "truncate",
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  const declaredLength = Number(headerValue(response, "content-length"));
  if (overflow === "reject" && Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new ResponseBodyTooLargeError(limitBytes);
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        const remaining = limitBytes - total;
        if (chunk.byteLength > remaining) {
          if (overflow === "reject") throw new ResponseBodyTooLargeError(limitBytes);
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          total = limitBytes;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      if (truncated) await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated };
  }

  const bytes = typeof response.arrayBuffer === "function"
    ? new Uint8Array(await response.arrayBuffer())
    : new TextEncoder().encode(typeof (response as Response & { text?: () => Promise<string> }).text === "function"
      ? await (response as Response & { text: () => Promise<string> }).text()
      : "");
  if (bytes.byteLength <= limitBytes) return { bytes, truncated: false };
  if (overflow === "reject") throw new ResponseBodyTooLargeError(limitBytes);
  return { bytes: bytes.subarray(0, limitBytes), truncated: true };
};

export async function decodeResponseText(
  response: Response,
  options: {
    kind?: DocumentKind;
    maxBytes?: number;
    overflow?: "reject" | "truncate";
  } = {},
): Promise<DecodedResponseText> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? STATIC_RESPONSE_MAX_BYTES));
  const { bytes, truncated } = await readBoundedBytes(response, maxBytes, options.overflow ?? "reject");
  const detectedBom = bom(bytes);
  const headerLabel = charsetFromContentType(headerValue(response, "content-type"));
  const declarationLabel = sniffDeclaration(bytes.subarray(detectedBom?.length ?? 0), options.kind ?? "text");
  const headerCharset = headerLabel && !detectedBom ? normalizeLabel(headerLabel) : null;
  const declarationCharset = declarationLabel && !detectedBom && !headerCharset ? normalizeLabel(declarationLabel) : null;
  const declaredCharset = detectedBom?.charset ?? headerCharset ?? declarationCharset ?? "utf-8";
  const payload = bytes.subarray(detectedBom?.length ?? 0);
  const declaredText = new TextDecoder(declaredCharset, { fatal: false }).decode(payload);
  const recoveredUtf8 = !detectedBom &&
    isSingleByteLegacyCharset(declaredCharset) &&
    isValidUtf8(payload) &&
    hasUtf8Mojibake(declaredText);
  const charset = recoveredUtf8 ? "utf-8" : declaredCharset;
  const charsetSource: CharsetSource = recoveredUtf8 ? "utf8_recovery" : detectedBom ? "bom" : headerCharset ? "http" : declarationCharset
    ? (options.kind === "xml" ? "xml" : "html")
    : "default";
  const lowerPriorityLabels = [detectedBom ? headerLabel : null, detectedBom || headerCharset ? declarationLabel : null]
    .filter((candidate): candidate is string => Boolean(candidate));
  const declarationConflict = lowerPriorityLabels.some((candidate) => {
    try { return normalizeLabel(candidate) !== charset; } catch { return true; }
  });
  let hadReplacement = false;
  try {
    new TextDecoder(charset, { fatal: true }).decode(payload);
  } catch {
    hadReplacement = true;
  }
  const text = new TextDecoder(charset, { fatal: false }).decode(payload).normalize("NFC");
  return { text, byteLength: bytes.byteLength, charset, charsetSource, hadReplacement, declarationConflict, truncated };
}
