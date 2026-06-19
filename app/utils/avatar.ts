export type AvatarUrlMap = Record<string, string>;

export function buildAvatarUrlMap(
  modules: Record<string, unknown>,
): AvatarUrlMap {
  const map: AvatarUrlMap = {};

  for (const path in modules) {
    const url = (modules as any)[path] as string;
    const basename = path.slice(path.lastIndexOf("/") + 1);
    map[basename] = url;
  }

  return map;
}

export function resolveAvatarUrlFromMap(
  stored: string | undefined | null,
  avatarByBasename: AvatarUrlMap,
): string | null {
  if (!stored) return null;

  const values = Object.values(avatarByBasename);
  if (values.includes(stored)) return stored;

  const maybeBase = String(stored).split("/").pop() || String(stored);
  return avatarByBasename[maybeBase] || null;
}
