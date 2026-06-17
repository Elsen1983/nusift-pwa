// plugins/hydrate.client.ts
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";

function resolveAvatarUrl(stored: string | undefined | null) {
  if (!stored) return null;

  const avatarModules = import.meta.glob('/assets/images/avatars/*.{png,jpg,jpeg,webp,svg}', { eager: true, as: 'url' });
  const avatarByBasename: Record<string, string> = {};

  for (const path in avatarModules) {
    const url = (avatarModules as any)[path] as string;
    const basename = path.slice(path.lastIndexOf('/') + 1);
    avatarByBasename[basename] = url;
  }

  if (Object.values(avatarByBasename).includes(stored)) {
    return stored;
  }

  const maybeBase = String(stored).split('/').pop() || String(stored);
  return avatarByBasename[maybeBase] || stored;
}

export default defineNuxtPlugin((nuxtApp) => {
  // A localStorage-ből csakis a böngészőben olvasunk, miután a Nuxt letöltött mindent
  const profileStr = localStorage.getItem("nusift_pwa_profile");
  
  if (profileStr) {
    try {
      const parsedUser = JSON.parse(profileStr);
      
      const authStore = useAuthStore();
      const agentStore = useAgentStore();

      // Normalize avatar if needed: accept basenames and already-resolved runtime URLs.
      try {
        if (parsedUser && parsedUser.profile) {
          const storedAvatar = parsedUser.profile.avatarUrl || (parsedUser.profile as any).avatar;
          const resolvedAvatar = resolveAvatarUrl(storedAvatar);
          if (resolvedAvatar) {
            parsedUser.profile.avatarUrl = resolvedAvatar;
            (parsedUser.profile as any).avatar = resolvedAvatar;
          }
        }
      } catch (e) {
        // ignore if asset glob is unavailable or parsing fails
      }

      // Hydrate the auth store even on hard refresh when the client store is still empty.
      // If SSR already created a base user object, keep patching that shape.
      if (authStore.user) {
        authStore.$patch({ user: { ...authStore.user, ...parsedUser } });
      } else {
        authStore.user = parsedUser;
      }

      // Agent Store feltöltése a kalibrációs adatokkal
      agentStore.$patch({
        primaryRegion: parsedUser.primaryRegion || null,
        topSources: parsedUser.topSources || [],
        topInterests: parsedUser.topInterests || []
      });
    } catch (error) {
      console.error("[Sovereign Hydration] Error parsing local profile", error);
    }
  }
});