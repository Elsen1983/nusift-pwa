const MAX_DIAGNOSTIC_LENGTH = 300;

const priorityFor = (value: string): number => {
  if (value.includes("push subscription deactivation persistence failed")) return 100;
  if (value.includes("push delivery evidence persistence failed")) return 90;
  if (value.includes("provider status 404") || value.includes("provider status 410")) return 80;
  if (value.includes("inbox notification persistence failed")) return 70;
  return 10;
};

function splitDiagnostics(value: string | null): string[] {
  return value ? value.split("; ").filter(Boolean) : [];
}

/**
 * Keep high-value facts visible even after many low-information endpoint
 * failures. Messages are known server-generated summaries; no raw provider
 * errors, endpoints, keys, payloads, or user identifiers are accepted here.
 */
export function appendBoundedDiagnostic(current: string | null, next: string): string {
  const messages = [...splitDiagnostics(current), next]
    .filter((message, index, all) => all.indexOf(message) === index)
    .sort((left, right) => priorityFor(right) - priorityFor(left));

  const selected: string[] = [];
  let length = 0;
  for (const message of messages) {
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (length + separatorLength + message.length <= MAX_DIAGNOSTIC_LENGTH) {
      selected.push(message);
      length += separatorLength + message.length;
    }
  }

  // Every current caller supplies short, server-generated messages. This
  // fallback preserves the newest fact if a future caller violates that rule.
  if (selected.length === 0) return next.slice(0, MAX_DIAGNOSTIC_LENGTH);
  return selected.join("; ");
}

export function boundedDiagnostic(value: string): string {
  return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export { MAX_DIAGNOSTIC_LENGTH };
