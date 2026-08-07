const STRONG_INTERSTITIAL_SIGNAL_GROUPS: ReadonlyArray<{
  code: "javascript_disabled" | "cookies_disabled";
  patterns: readonly RegExp[];
}> = [
  {
    code: "javascript_disabled",
    patterns: [
      /javascript(?:\s+is)?\s+disabled/i,
      /enable\s+javascript/i,
      /le\s+van\s+tiltva\s+a\s+javascript/i,
      /enged\u00e9lyezd\s+a\s+javascript\s+fut\u00e1s\u00e1t/i,
    ],
  },
  {
    code: "cookies_disabled",
    patterns: [
      /cookies?\s+(?:are|is)\s+disabled/i,
      /enable\s+(?:the\s+)?cookies?/i,
      /le\s+van\s+tiltva\s+a\s+s\u00fctik?\s+haszn\u00e1lata/i,
      /enged\u00e9lyezd\s+a\s+s\u00fctik?\s+haszn\u00e1lat\u00e1t/i,
    ],
  },
];

export function detectStrongInterstitialSignals(text: string): string[] {
  return STRONG_INTERSTITIAL_SIGNAL_GROUPS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ code }) => `interstitial_signal:${code}`);
}

export function hasBlockingInterstitialSignalPair(signals: readonly string[]): boolean {
  return signals.includes("interstitial_signal:javascript_disabled") &&
    signals.includes("interstitial_signal:cookies_disabled");
}

export function isBlockingInterstitialBody(bodyText: string | null | undefined): boolean {
  return typeof bodyText === "string" &&
    hasBlockingInterstitialSignalPair(detectStrongInterstitialSignals(bodyText));
}
