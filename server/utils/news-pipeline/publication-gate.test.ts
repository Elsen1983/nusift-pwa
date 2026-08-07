import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicationGateUpdate,
  buildUserFeedPublicationWhere,
  getTerminalPublicationStage,
  isEffectivelyPublishableArticle,
} from "./publication-gate";

describe("publication gate", () => {
  afterEach(() => {
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
  });

  it("uses Agent 3 as the current terminal stage", () => {
    const completedAt = new Date("2026-07-31T12:00:00.000Z");
    expect(getTerminalPublicationStage()).toBe("agent3");
    expect(buildPublicationGateUpdate({ stage: "agent3", publishable: true, completedAt })).toEqual({
      publicationStatus: "PUBLISHED",
      publicationStage: "agent3",
      publicationReadyAt: completedAt,
    });
  });

  it("moves publication responsibility to a later configured agent", () => {
    process.env.NUXT_PIPELINE_TERMINAL_STAGE = "agent4";
    const completedAt = new Date("2026-07-31T12:00:00.000Z");

    expect(buildPublicationGateUpdate({ stage: "agent3", publishable: true, completedAt }).publicationStatus).toBe("PROCESSING");
    expect(buildPublicationGateUpdate({ stage: "agent4", publishable: true, completedAt }).publicationStatus).toBe("PUBLISHED");
  });

  it("requires the default terminal stage in the user-feed predicate", () => {
    expect(buildUserFeedPublicationWhere()).toEqual(expect.objectContaining({
      publicationStatus: "PUBLISHED",
      publicationStage: "agent3",
    }));
  });

  it("requires the configured terminal stage in the user-feed predicate", () => {
    process.env.NUXT_PIPELINE_TERMINAL_STAGE = "agent4";

    expect(buildUserFeedPublicationWhere()).toEqual(expect.objectContaining({
      publicationStatus: "PUBLISHED",
      publicationStage: "agent4",
    }));
  });

  it("uses the same runtime eligibility rule for feed and notification defense-in-depth", () => {
    expect(isEffectivelyPublishableArticle({
      title: "  Valid title  ",
      canonicalUrl: "\thttps://example.com/article\n",
      bodyText: `\n${"A".repeat(500)}\t`,
    })).toBe(true);
    for (const article of [
      { title: "   \t\n", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(500) },
      { title: "Valid", canonicalUrl: "  \n", bodyText: "A".repeat(500) },
      { title: "Valid", canonicalUrl: "https://example.com/a", bodyText: "A".repeat(499) },
      { title: "Valid", canonicalUrl: "https://example.com/a", bodyText: null },
    ]) {
      expect(isEffectivelyPublishableArticle(article)).toBe(false);
    }
  });

  it("rejects a persisted JavaScript/cookie blocker even when it exceeds the body length threshold", () => {
    const blocker = [
      "Le van tiltva a JavaScript. Kerlek, enged\u00e9lyezd a JavaScript fut\u00e1s\u00e1t a b\u00f6ng\u00e9sz\u0151dben!",
      "Le van tiltva a s\u00fctik haszn\u00e1lata. Kerlek, enged\u00e9lyezd a s\u00fctik haszn\u00e1lat\u00e1t a b\u00f6ng\u00e9sz\u0151dben!",
      "Torold a bongeszod gyorsitotarat, majd probald meg ujra betolteni az oldalt. ".repeat(8),
    ].join("\n\n");

    expect(blocker.length).toBeGreaterThanOrEqual(500);
    expect(isEffectivelyPublishableArticle({
      title: "A GCC-bol is kitiltottak",
      canonicalUrl: "https://prog.hu/hirek/7155/example",
      bodyText: blocker,
    })).toBe(false);
  });

  it("withholds a non-publishable outcome and removes a prior publication", () => {
    const completedAt = new Date("2026-07-31T12:00:00.000Z");
    expect(buildPublicationGateUpdate({ stage: "agent3", publishable: false, completedAt })).toEqual({
      publicationStatus: "PROCESSING",
      publicationStage: "agent3",
      publicationReadyAt: null,
    });
    expect(buildPublicationGateUpdate({
      stage: "agent3",
      publishable: false,
      nonPublishableStatus: "REJECTED",
      completedAt,
    }).publicationStatus).toBe("REJECTED");
  });
});
