<template>
  <div
    class="bg-background text-on-background min-h-screen font-body selection:bg-primary-container/30 flex justify-center"
  >
    <div class="w-full max-w-2xl relative min-h-screen">
      <div
        class="fixed top-0 inset-x-0 mx-auto w-full max-w-2xl bg-background z-[100] border-b border-white/5"
      >
        <header
          class="flex justify-between items-center px-6 py-3 w-full h-[60px]"
        >
          <button
            @click="navigate.push('/dashboard')"
            class="flex items-center group transition-all duration-300 text-left"
          >
            <ClientOnly>
              <img
                v-if="isLightMode"
                alt="NuSift Logo"
                class="h-[28px] w-auto object-contain"
                src="~/assets/images/NuSift_Transparent_Logo_Blue.png"
              />
              <img
                v-else
                alt="NuSift Logo"
                class="h-[28px] w-auto object-contain"
                src="~/assets/images/NuSift_Transparent_Logo.png"
              />
            </ClientOnly>
            <div class="ml-4 pl-4 border-l border-primary-container/30 py-1">
              <span
                class="text-primary-container font-label text-[9px] uppercase tracking-[0.15em] leading-tight block opacity-80 group-hover:opacity-100 transition-opacity"
              >
                {{ $t("appLayout.header.slogan_line1") }}<br />{{
                  $t("appLayout.header.slogan_line2")
                }}
              </span>
            </div>
          </button>

          <div
            class="relative flex items-center gap-4"
            v-click-outside="() => (isProfileMenuOpen = false)"
          >
            <div class="relative">
            <button
              @click="isProfileMenuOpen = !isProfileMenuOpen"
              :aria-expanded="isProfileMenuOpen"
              aria-label="Open app menu"
              class="menu-trigger relative w-11 h-11 rounded-2xl border border-primary-container/15 bg-surface-container-high/90 backdrop-blur-xl shadow-[0_0_20px_rgba(0,229,255,0.10)] transition-all duration-300 hover:border-primary-container/35 hover:shadow-[0_0_24px_rgba(0,229,255,0.18)] active:scale-95"
              :class="isProfileMenuOpen ? 'bg-[#00E5FF]/10 border-primary-container/40' : ''"
            >
              <span
                class="absolute inset-0 rounded-2xl bg-gradient-to-br from-[#00E5FF]/12 via-transparent to-transparent opacity-80"
              ></span>
              <span class="menu-icon material-symbols-outlined">
                {{ isProfileMenuOpen ? "close" : "settings" }}
              </span>
            </button>
              <span
                v-if="unreadNotificationCount > 0"
                class="notification-badge absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-error text-white text-[10px] font-bold flex items-center justify-center border-2 border-background shadow-md pointer-events-none"
              >
                {{ unreadNotificationCount > 99 ? "99+" : unreadNotificationCount }}
              </span>
            </div>

            <transition name="dropdown">
              <div
                v-if="isProfileMenuOpen"
                class="absolute top-14 right-0 w-[290px] overflow-hidden rounded-[28px] border border-white/10 bg-surface-container-low/95 backdrop-blur-2xl shadow-[0_20px_60px_rgba(0,0,0,0.45)] z-[110]"
              >
                <div class="p-2 space-y-1">
                  <button
                    @click="handleMenuNavigation('/profile')"
                    class="menu-item group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">account_circle</span>
                    <span class="menu-item-text">
                      <span class="block text-sm font-medium text-on-surface">
                        {{ $t("appLayout.profileMenu.my_profile") }}
                      </span>
                      <span class="block text-[11px] text-on-surface-variant">
                        {{ $t("appLayout.profileMenu.my_profile_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>

                  <button
                    @click="handleMenuNavigation('/audit/categories-setup')"
                    class="menu-item group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">cards_stack</span>
                    <span class="menu-item-text">
                      <span class="block text-sm font-medium text-on-surface">
                        {{ $t("appLayout.profileMenu.agent_fine_tuning") }}
                      </span>
                      <span class="block text-[11px] text-on-surface-variant">
                        {{ $t("appLayout.profileMenu.agent_fine_tuning_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>

                  <button
                    @click="handleMenuNavigation('/audit/source-manager')"
                    class="menu-item group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">hub</span>
                    <span class="menu-item-text">
                      <span class="block text-sm font-medium text-on-surface">
                        {{ $t("appLayout.profileMenu.source_manager") }}
                      </span>
                      <span class="block text-[11px] text-on-surface-variant">
                        {{ $t("appLayout.profileMenu.source_manager_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>

                  <button
                    @click="handleMenuNavigation('/notifications')"
                    class="menu-item group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">notifications</span>
                    <span class="menu-item-text">
                      <span class="flex items-center gap-2">
                        <span class="block text-sm font-medium text-on-surface">
                          {{ $t("appLayout.profileMenu.notifications") }}
                        </span>
                        <span
                          v-if="unreadNotificationCount > 0"
                          class="notification-badge min-w-[18px] h-[18px] px-1.5 rounded-full bg-error text-white text-[9px] font-bold flex items-center justify-center border border-background/80 shadow-sm"
                        >
                          {{ unreadNotificationCount > 99 ? "99+" : unreadNotificationCount }}
                        </span>
                      </span>
                      <span class="block text-[11px] text-on-surface-variant">
                        {{ $t("appLayout.profileMenu.notifications_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>

                  <button
                    @click="handleMenuNavigation('/settings')"
                    class="menu-item group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">tune</span>
                    <span class="menu-item-text">
                      <span class="block text-sm font-medium text-on-surface">
                        {{ $t("appLayout.profileMenu.app_settings") }}
                      </span>
                      <span class="block text-[11px] text-on-surface-variant">
                        {{ $t("appLayout.profileMenu.app_settings_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>

                  <div class="h-px bg-white/5 my-2"></div>

                  <button
                    @click="openLogoutModal"
                    class="menu-item menu-item-danger group w-full"
                  >
                    <span class="menu-item-icon material-symbols-outlined">logout</span>
                    <span class="menu-item-text">
                      <span class="block text-sm font-medium">
                        {{ $t("appLayout.profileMenu.logout") }}
                      </span>
                      <span class="block text-[11px] text-error/70">
                        {{ $t("appLayout.profileMenu.logout_desc") }}
                      </span>
                    </span>
                    <span class="menu-item-chev material-symbols-outlined">chevron_right</span>
                  </button>
                </div>
              </div>
            </transition>
          </div>
        </header>
      </div>

      <main class="pt-[60px] pb-28 w-full">
        <slot />
      </main>

      <nav
        class="fixed bottom-0 inset-x-0 mx-auto w-full max-w-2xl bg-background/95 backdrop-blur-xl border-t border-white/5 z-[100] pb-safe"
      >
        <div class="flex justify-around items-center h-16 w-full px-2">
          <button
            v-for="item in navItems"
            :key="item.path"
            @click="navigate.push(item.path)"
            class="flex flex-col items-center justify-center w-full h-full gap-1 transition-colors"
            :class="[
              route.path.includes(item.path)
                ? 'text-primary-container'
                : 'text-on-surface-variant hover:text-white',
            ]"
          >
            <span
              class="material-symbols-outlined text-[24px]"
              :class="{ 'text-[28px]': route.path.includes(item.path) }"
            >
              {{ item.icon }}
            </span>
            <span class="text-[10px] font-medium tracking-wide">
              {{ item.label }}
            </span>
          </button>
        </div>
      </nav>

      <LogoutModal
        :is-open="isLogoutModalOpen"
        @close="isLogoutModalOpen = false"
        @confirm="handleSecureLogout"
      />
      <UnsavedChangesModal
        :is-open="isUnsavedModalOpen"
        @close="cancelUnsavedLeave"
        @confirm="confirmUnsavedLeave"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useUnsavedStore } from "~/stores/unsaved";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import { $api } from "~/utils/api";
import { useI18n } from "vue-i18n";

const { t, locale } = useI18n();
const colorMode = useColorMode();
const route = useRoute();
const localePath = useLocalePath();
const navigate = useSovereignNavigate();
const authStore = useAuthStore();
const agentStore = useAgentStore();

const isProfileMenuOpen = ref(false);
const isLogoutModalOpen = ref(false);
const isUnsavedModalOpen = ref(false);
const pendingNavPath = ref<string | null>(null);
const unreadNotificationCount = useState<number>("unreadNotificationCount", () => 0);
const isLightMode = computed(() => colorMode.value === "light");

const navItems = computed(() => [
  {
    label: t("appLayout.navigation.feed"),
    icon: "auto_awesome_motion",
    path: "/dashboard",
  },
  { label: t("appLayout.navigation.saved"), icon: "bookmark", path: "/articles/saved" },
  { label: t("appLayout.navigation.shared"), icon: "share", path: "/articles/shared" },
  {
    label: t("appLayout.navigation.trends"),
    icon: "insights",
    path: "/articles/trends",
  },
]);

const unsavedStore = useUnsavedStore();

const handleMenuNavigation = (path: string) => {
  isProfileMenuOpen.value = false;
  try {
    if (unsavedStore.anyDirty) {
      pendingNavPath.value = path;
      isUnsavedModalOpen.value = true;
      return;
    }
  } catch (e) {
    console.warn('[app-layout] could not check unsaved store', e);
  }
  navigate.push(path);
};

const confirmUnsavedLeave = () => {
  isUnsavedModalOpen.value = false;
  const path = pendingNavPath.value;
  pendingNavPath.value = null;
  if (path) navigate.push(path);
};

const cancelUnsavedLeave = () => {
  isUnsavedModalOpen.value = false;
  pendingNavPath.value = null;
};

const openLogoutModal = () => {
  isProfileMenuOpen.value = false;
  isLogoutModalOpen.value = true;
};

const handleSecureLogout = async () => {
  // 1. Megkérjük a szervert, hogy semmisítse meg a HttpOnly sütiket
  try {
    await $api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Sovereign Shield: Logout API hívás sikertelen", error);
  }

  // 2. Kliensoldali állapotok tisztítása
  const token = useCookie("auth_token");
  token.value = null;

  if (typeof authStore.$reset === "function") {
    authStore.$reset();
  } else {
    authStore.user = null;
  }

  if (typeof agentStore.$reset === "function") {
    agentStore.$reset();
  }

  if (import.meta.client) {
    sessionStorage.clear();

    // Hard-redirect a bejelentkező oldalra
    const savedLang = localStorage.getItem("nusift_preferred_language");
    const redirectLang =
      (savedLang === "en" || savedLang === "hu" || savedLang === "fr" || savedLang === "de" || savedLang === "pl" || savedLang === "es")
        ? savedLang
        : locale.value;
    window.location.href = localePath("/auth", redirectLang);
  }
};

onMounted(async () => {
  if (authStore.user) {
    const { $refreshUnreadNotifications } = useNuxtApp();
    await $refreshUnreadNotifications?.();
  }
});

const vClickOutside = {
  mounted(el: any, binding: any) {
    el.clickOutsideEvent = (event: Event) => {
      if (!(el === event.target || el.contains(event.target))) {
        binding.value();
      }
    };
    document.body.addEventListener("click", el.clickOutsideEvent);
  },
  unmounted(el: any) {
    document.body.removeEventListener("click", el.clickOutsideEvent);
  },
};
</script>

<style scoped>
.menu-trigger {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.menu-trigger::before {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: 1rem;
  border: 1px solid rgba(255, 255, 255, 0.04);
  pointer-events: none;
}

.menu-icon {
  position: relative;
  z-index: 1;
  font-variation-settings: "FILL" 1, "wght" 400, "GRAD" 0, "opsz" 24;
  font-size: 22px;
  color: rgb(var(--color-primary-container));
  transition:
    transform 220ms ease,
    opacity 180ms ease,
    color 220ms ease;
}

.light .menu-icon {
  color: rgb(var(--color-primary));
}

.menu-trigger:hover .menu-icon {
  transform: rotate(28deg) scale(1.04);
}

.menu-trigger[aria-expanded="true"] .menu-icon {
  transform: rotate(180deg) scale(1.05);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  width: 100%;
  padding: 0.9rem 0.9rem;
  border-radius: 1.15rem;
  text-align: left;
  transition:
    background-color 180ms ease,
    transform 180ms ease,
    border-color 180ms ease;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.045);
  transform: translateY(-1px);
}

.menu-item-danger:hover {
  background: rgba(255, 82, 82, 0.08);
}

.menu-item-icon {
  flex: 0 0 auto;
  color: #00e5ff;
  font-size: 20px;
}

.menu-item-danger .menu-item-icon,
.menu-item-danger .menu-item-chev,
.menu-item-danger .menu-item-text {
  color: inherit;
}

.menu-item-text {
  flex: 1 1 auto;
  min-width: 0;
}

.menu-item-chev {
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.34);
  font-size: 18px;
  transition: transform 180ms ease, color 180ms ease;
}

.menu-item:hover .menu-item-chev {
  transform: translateX(2px);
  color: rgba(255, 255, 255, 0.7);
}

.notification-badge {
  animation: notification-badge-pulse 2.2s ease-in-out infinite;
  transform-origin: center;
}

@keyframes notification-badge-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(255, 82, 82, 0.3);
  }
  50% {
    transform: scale(1.06);
    box-shadow: 0 0 0 6px rgba(255, 82, 82, 0);
  }
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-12px) scale(0.96);
}
</style>
