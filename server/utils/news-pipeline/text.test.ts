import { describe, expect, it } from "vitest";
import { stripHtml } from "./text";

describe("stripHtml", () => {
  it("preserves CDATA text content used by RSS titles", () => {
    const input =
      "<![CDATA[West Waterford mourns loss of respected GAA figure Mike Kearney - His contribution was immense]]>";

    expect(stripHtml(input)).toBe(
      "West Waterford mourns loss of respected GAA figure Mike Kearney - His contribution was immense",
    );
  });
});
