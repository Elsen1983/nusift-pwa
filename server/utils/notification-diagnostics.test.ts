import { describe, expect, it } from "vitest";
import { appendBoundedDiagnostic } from "./notification-diagnostics";

describe("notification diagnostics", () => {
  it("retains late high-priority facts within the bound", () => {
    let diagnostic: string | null = null;
    for (let index = 0; index < 30; index += 1) {
      diagnostic = appendBoundedDiagnostic(diagnostic, `push delivery failed (transient ${index})`);
    }
    diagnostic = appendBoundedDiagnostic(diagnostic, "push delivery failed (provider status 410)");
    diagnostic = appendBoundedDiagnostic(diagnostic, "push subscription deactivation persistence failed");

    expect(diagnostic.length).toBeLessThanOrEqual(300);
    expect(diagnostic).toContain("provider status 410");
    expect(diagnostic).toContain("deactivation persistence failed");
    expect(diagnostic).not.toContain("https://push.example");
    expect(diagnostic).not.toContain("p256dh");
    expect(diagnostic).not.toContain("auth");
  });

  it("deduplicates repeated provider statuses", () => {
    const diagnostic = appendBoundedDiagnostic(
      appendBoundedDiagnostic(null, "push delivery failed (provider status 410)"),
      "push delivery failed (provider status 410)",
    );
    expect(diagnostic).toBe("push delivery failed (provider status 410)");
  });
});
