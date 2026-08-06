export type SettingsPushState =
  | "unsupported"
  | "unavailable"
  | "permission-default"
  | "permission-granted-unsubscribed"
  | "active"
  | "permission-denied"
  | "registering"
  | "unregistering"
  | "recoverable-error";

export type PushToggleAction = "enable" | "disable" | "noop";

export function canActivatePush(state: SettingsPushState, active: boolean): boolean {
  return state !== "permission-denied" || active;
}

export function isActivationToggleDisabled(
  state: SettingsPushState,
  active: boolean,
  operation: "idle" | "registering" | "unregistering",
): boolean {
  return operation !== "idle" || !canActivatePush(state, active);
}

export function decidePushToggle(
  state: SettingsPushState,
  active: boolean,
  nextEnabled: boolean,
): PushToggleAction {
  if (nextEnabled && !canActivatePush(state, active)) return "noop";
  return nextEnabled ? "enable" : "disable";
}
