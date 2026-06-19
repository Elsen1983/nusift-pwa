// plugins/hydrate.client.ts
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import { buildAvatarUrlMap, resolveAvatarUrlFromMap } from "~/utils/avatar";

const avatarModules = import.meta.glob('/assets/images/avatars/*.{png,jpg,jpeg,webp,svg}', { eager: true, as: 'url' });
const avatarByBasename = buildAvatarUrlMap(avatarModules as Record<string, unknown>);

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
          const resolvedAvatar = resolveAvatarUrlFromMap(storedAvatar, avatarByBasename);
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
