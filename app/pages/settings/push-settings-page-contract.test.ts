import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canActivatePush } from "./push-settings-policy";

describe("settings push page contract", () => {
  it("keeps denied inactive activation blocked while preserving active disable and refresh", () => {
    const source = readFileSync(resolve(process.cwd(), "app/pages/settings/index.vue"), "utf8");
    expect(source).toContain("isActivationToggleDisabled(pushState, pushEnabled, pushOperation)");
    expect(source).toContain("const action = decidePushToggle(pushState.value, pushEnabled.value, nextEnabled);");
    expect(source).toContain("if (action === \"noop\") return;");
    expect(source).toContain("pushState === 'active' || (pushState === 'permission-denied' && pushEnabled)");
    expect(source).toContain("@click=\"refreshPushStatus\"");
    expect(canActivatePush("permission-denied", false)).toBe(false);
    expect(canActivatePush("permission-denied", true)).toBe(true);
  });
});
