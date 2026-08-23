export type ArticleExtractionLanguage = "en" | "hu";

interface ArticleExtractionLanguagePolicy {
  boundaryText: readonly RegExp[];
  boilerplateText: readonly RegExp[];
}

const LANGUAGE_POLICIES: Readonly<Record<ArticleExtractionLanguage, ArticleExtractionLanguagePolicy>> = {
  en: {
    boundaryText: [
      /^more\s+(by|from|stories|news|on|about)/i,
      /^more\s*$/i,
      /^related\s*(articles?|stories|posts?|content|links?|news)?$/i,
      /^recommended\s*(articles?|stories|posts?|for\s*you)?$/i,
      /^most\s*(read|popular|viewed|shared|commented)/i,
      /^popular\s*(articles?|stories|posts?|now|today)?$/i,
      /^trending\s*(now|today|stories|articles?)?$/i,
      /^latest\s*(news|stories|articles?|updates?)?$/i,
      /^read\s*more$/i,
      /^also\s*read$/i,
      /^see\s*also$/i,
      /^around\s*the\s*web$/i,
      /^you\s*may\s*also\s*(like|enjoy)/i,
      /^from\s*(our|the)\s*(partners?|sponsors?|network)/i,
      /^sponsored\s*(content|stories|by)/i,
      /^top\s*(stories|articles?|news)/i,
      /^elsewhere\s*on\s*\w+/i,
    ],
    boilerplateText: [
      /^(share|tweet|pin|email|print|subscribe|sign up|follow us)/i,
      /^(related articles?|more (from|stories|news)|you may also like)/i,
      /^(advertisement|sponsored|promoted)/i,
      /^(?:©|copyright|all rights reserved)/i,
      /^(click here|read more|continue reading|load more)/i,
      /^(loading|please wait)/i,
      /^(cookie|privacy policy|terms of (use|service))/i,
    ],
  },
  hu: {
    boundaryText: [
      /^kapcsolódó(?:\s+(?:cikkek?|tartalmak?))?$/i,
      /^további(?:\s+[\p{L}\p{N}-]+){0,3}\s+cikkek?$/iu,
      /^ehhez\s+a\s+cikkhez\s+ajánljuk$/i,
      /^ezt\s+is\s+ajánljuk$/i,
      /^ajánljuk(?:\s+még)?$/i,
      /^legolvasottabb(?:\s+cikkek?)?$/i,
      /^legnépszerűbb(?:\s+cikkek?)?$/i,
      /^népszerű(?:\s+cikkek?)?$/i,
      /^további\s+híreink$/i,
      /^még\s+több(?:\s+[\p{L}\p{N}-]+){0,3}$/iu,
    ],
    boilerplateText: [
      /^kövesse\s+(?:az|a)\s+.{1,80}\s+(?:facebookon|instagramon|youtube-on|x-en|tiktokon)(?:\s+is)?[!.]?$/iu,
      /^(?:megosztás|megosztom|hirdetés)$/i,
      /^iratkozzon\s+fel/i,
      /^tovább\s+a\s+(?:termékoldalra|rovatra)$/i,
      /^olvassa\s+el\s+ezt\s+is$/i,
      /^sütik?(?:\s+kezelése)?$/i,
      /^adatvédelmi\s+(?:tájékoztató|szabályzat)$/i,
    ],
  },
};

function normalizeLanguageTag(value: string | null | undefined): ArticleExtractionLanguage | null {
  const primary = value?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return primary === "en" || primary === "hu" ? primary : null;
}

export function detectArticleExtractionLanguage(doc: Document): ArticleExtractionLanguage {
  const declaredValues = [
    doc.documentElement?.getAttribute("lang"),
    doc.querySelector('meta[property="og:locale"]')?.getAttribute("content"),
    doc.querySelector('meta[http-equiv="content-language"]')?.getAttribute("content"),
    doc.querySelector('meta[name="language"]')?.getAttribute("content"),
  ];

  for (const value of declaredValues) {
    const language = normalizeLanguageTag(value);
    if (language) return language;
  }

  return "en";
}

function policiesFor(language: ArticleExtractionLanguage): readonly ArticleExtractionLanguagePolicy[] {
  return language === "en"
    ? [LANGUAGE_POLICIES.en]
    : [LANGUAGE_POLICIES.en, LANGUAGE_POLICIES[language]];
}

export function matchesArticleBoundaryText(
  text: string,
  language: ArticleExtractionLanguage,
): boolean {
  const normalized = text.trim();
  return policiesFor(language).some((policy) =>
    policy.boundaryText.some((pattern) => pattern.test(normalized)),
  );
}

export function matchesArticleBoilerplateText(
  text: string,
  language: ArticleExtractionLanguage,
): boolean {
  const normalized = text.trim();
  return policiesFor(language).some((policy) =>
    policy.boilerplateText.some((pattern) => pattern.test(normalized)),
  );
}
