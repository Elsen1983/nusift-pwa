import { describe, expect, it } from "vitest";
import { repairUtf8Mojibake } from "./text-encoding";

describe("repairUtf8Mojibake", () => {
  it("repairs common UTF-8 decoded as Windows-1252", () => {
    expect(repairUtf8Mojibake("VÃ­zjelezni fogja, ha Å‘ generÃ¡lta")).toBe("Vízjelezni fogja, ha ő generálta");
  });

  it("repairs a bounded double-decoding pass", () => {
    expect(repairUtf8Mojibake("GardaÃƒÂ­")).toBe("Gardaí");
  });

  it("does not mutate ordinary Unicode text", () => {
    expect(repairUtf8Mojibake("Őszinte hírek – már elérhetők")).toBe("Őszinte hírek – már elérhetők");
  });
});
