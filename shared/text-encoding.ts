const WINDOWS_1252_BYTES: Readonly<Record<string, number>> = {
  "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84, "\u2026": 0x85,
  "\u2020": 0x86, "\u2021": 0x87, "\u02c6": 0x88, "\u2030": 0x89, "\u0160": 0x8a,
  "\u2039": 0x8b, "\u0152": 0x8c, "\u017d": 0x8e, "\u2018": 0x91, "\u2019": 0x92,
  "\u201c": 0x93, "\u201d": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02dc": 0x98, "\u2122": 0x99, "\u0161": 0x9a, "\u203a": 0x9b, "\u0153": 0x9c,
  "\u017e": 0x9e, "\u0178": 0x9f,
};

// Unicode escapes keep this detector source-encoding independent.
const MOJIBAKE_MARKER = /(?:\u00c3[\u0080-\u00bf\u0192]|\u00c2[\u0080-\u00bf]|\u00c5[\u0080-\u00bf\u2018\u2019]|\u00e2[\u0080-\u00bf])/;

const encodeWindows1252 = (input: string): Uint8Array | null => {
  const bytes: number[] = [];
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }
    const mapped = WINDOWS_1252_BYTES[character];
    if (mapped === undefined) return null;
    bytes.push(mapped);
  }
  return new Uint8Array(bytes);
};

/**
 * Repairs UTF-8 bytes that were decoded once or twice as Windows-1252.
 * It is intentionally conservative: text without a recognised marker, values
 * outside the reversible Windows-1252 range, and invalid UTF-8 are unchanged.
 */
export const repairUtf8Mojibake = (input: string): string => {
  let value = input;
  for (let attempt = 0; attempt < 2 && MOJIBAKE_MARKER.test(value); attempt += 1) {
    const bytes = encodeWindows1252(value);
    if (!bytes) break;
    try {
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
      if (!repaired || repaired === value || MOJIBAKE_MARKER.test(repaired)) {
        if (repaired && repaired !== value && attempt === 0) value = repaired;
        continue;
      }
      value = repaired;
    } catch {
      break;
    }
  }
  return value;
};

export const hasLikelyUtf8Mojibake = (input: string): boolean => MOJIBAKE_MARKER.test(input);
