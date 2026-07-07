export type NormalizationFlag =
  | "entity_decoded"
  | "cdata_stripped"
  | "mojibake_repaired"
  | "source_heuristic_applied"
  | "suspected_mojibake";

export interface NormalizedFeedTextResult {
  value: string;
  flags: NormalizationFlag[];
  suspicionScore: number;
  changed: boolean;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: "\"",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: "\"",
  ldquo: "\"",
};

const DIRECT_REPLACEMENTS: Array<[string, string]> = [
  ["â€˜", "‘"],
  ["â€™", "’"],
  ["â€œ", "“"],
  ["â€", "”"],
  ["â€ž", "„"],
  ["â€“", "–"],
  ["â€”", "—"],
  ["â€¦", "…"],
  ["â‚¬", "€"],
  ["Â£", "£"],
  ["Â ", " "],
  ["Ã‰", "É"],
  ["Ã©", "é"],
  ["Ã¡", "á"],
  ["Ã­", "í"],
  ["Ã³", "ó"],
  ["Ã¶", "ö"],
  ["Ãº", "ú"],
  ["Ã¼", "ü"],
  ["Ã", "Á"],
  ["Ã", "Í"],
  ["Ã“", "Ó"],
  ["Ã–", "Ö"],
  ["Ãš", "Ú"],
  ["Ãœ", "Ü"],
  ["Ä—", "ē"],
];

const SUSPICIOUS_PATTERNS = [
  "â€",
  "â‚¬",
  "Ã",
  "Â",
  "Ä",
  "\u0018",
  "\u0019",
  "\u001d",
  "\u001e",
  "\ufffd",
];

const decodeHtmlEntitiesDetailed = (input: string) => {
  let changed = false;
  const value = input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (!entity) return match;

    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const raw = isHex ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
      if (!Number.isFinite(codePoint)) return match;
      try {
        changed = true;
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    const replacement = HTML_ENTITY_MAP[entity.toLowerCase()];
    if (!replacement) return match;
    changed = true;
    return replacement;
  });

  return { value, changed };
};

const applyDirectReplacements = (input: string) => {
  let value = input;
  let changed = false;

  for (const [from, to] of DIRECT_REPLACEMENTS) {
    if (!value.includes(from)) continue;
    value = value.split(from).join(to);
    changed = true;
  }

  return { value, changed };
};

const applySourceHeuristics = (input: string) => {
  const rules: Array<[RegExp, string]> = [
    [/\bGardaÃ­\b/g, "Gardaí"],
    [/\bgardaÃ­\b/g, "gardaí"],
    [/\bMet Ã‰ireann\b/g, "Met Éireann"],
    [/\bFÃ©ile\b/g, "Féile"],
    [/\bMÃ³glaÃ­\b/g, "Móglaí"],
    [/\bProvaÃ­\b/g, "Provaí"],
    [/\bRuginienÄ—\b/g, "Ruginienė"],
    [/\bJoninÄ—s\b/g, "Joninės"],
  ];

  let value = input;
  let changed = false;

  for (const [pattern, replacement] of rules) {
    if (!pattern.test(value)) continue;
    value = value.replace(pattern, replacement);
    changed = true;
  }

  return { value, changed };
};

const computeSuspicionScore = (input: string) =>
  SUSPICIOUS_PATTERNS.reduce(
    (score, token) => score + (input.includes(token) ? 1 : 0),
    0,
  );

export const normalizeFeedTextDetailed = (input: string): NormalizedFeedTextResult => {
  const flags: NormalizationFlag[] = [];
  const original = input;

  let value = input.trim();

  const stripped = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  if (stripped !== value) {
    value = stripped;
    flags.push("cdata_stripped");
  }

  const entityDecoded = decodeHtmlEntitiesDetailed(value);
  value = entityDecoded.value;
  if (entityDecoded.changed) {
    flags.push("entity_decoded");
  }

  const beforeRepairScore = computeSuspicionScore(value);

  const direct = applyDirectReplacements(value);
  value = direct.value;
  if (direct.changed) {
    flags.push("mojibake_repaired");
  }

  const heuristic = applySourceHeuristics(value);
  value = heuristic.value;
  if (heuristic.changed) {
    flags.push("source_heuristic_applied");
  }

  const afterRepairScore = computeSuspicionScore(value);
  if (afterRepairScore > 0 || beforeRepairScore > 0) {
    flags.push("suspected_mojibake");
  }

  return {
    value,
    flags: [...new Set(flags)],
    suspicionScore: afterRepairScore,
    changed: value !== original.trim(),
  };
};
