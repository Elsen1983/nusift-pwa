import { describe, expect, it } from "vitest";
import { canActivatePush, decidePushToggle, isActivationToggleDisabled } from "./push-settings-policy";

describe("push settings activation policy", () => {
  it("blocks denied inactive activation but permits disabling an active subscription", () => {
    expect(canActivatePush("permission-denied", false)).toBe(false);
    expect(canActivatePush("permission-denied", true)).toBe(true);
    expect(isActivationToggleDisabled("permission-denied", false, "idle")).toBe(true);
    expect(isActivationToggleDisabled("permission-denied", true, "idle")).toBe(false);
    expect(decidePushToggle("permission-denied", false, true)).toBe("noop");
    expect(decidePushToggle("permission-denied", true, false)).toBe("disable");
  });

  it("keeps refresh independent and permits default/recoverable activation", () => {
    expect(canActivatePush("permission-default", false)).toBe(true);
    expect(canActivatePush("recoverable-error", false)).toBe(true);
    expect(isActivationToggleDisabled("permission-default", false, "idle")).toBe(false);
    expect(isActivationToggleDisabled("recoverable-error", false, "idle")).toBe(false);
    expect(isActivationToggleDisabled("permission-default", false, "registering")).toBe(true);
    expect(decidePushToggle("permission-default", false, true)).toBe("enable");
    expect(decidePushToggle("recoverable-error", false, true)).toBe("enable");
  });
});
