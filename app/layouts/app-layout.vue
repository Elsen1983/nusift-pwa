<template>
  <div
    class="bg-background text-on-background min-h-screen font-body selection:bg-primary-container/30 flex justify-center"
  >
    <div class="w-full max-w-2xl relative min-h-screen">
      <div
        class="fixed top-0 inset-x-0 mx-auto w-full max-w-2xl bg-[#131313] z-[100] border-b border-white/5"
      >
        <header
          class="flex justify-between items-center px-6 py-3 w-full h-[60px]"
        >
          <button
            @click="navigate.push('/dashboard')"
            class="flex items-center group transition-all duration-300 text-left"
          >
            <img
              alt="NuSift Logo"
              class="h-[28px] w-auto object-contain"
              src="~/assets/images/NuSift_Transparent_Logo.png"
            />
            <div class="ml-4 pl-4 border-l border-[#00E5FF]/30 py-1">
              <span
                class="text-[#00E5FF] font-label text-[9px] uppercase tracking-[0.15em] leading-tight block opacity-80 group-hover:opacity-100 transition-opacity"
              >
                {{ $t("appLayout.header.slogan_line1") }}<br />{{
                  $t("appLayout.header.slogan_line2")
                }}
              </span>
            </div>
          </button>

          <div
            class="flex items-center gap-4 relative"
            v-click-outside="() => (isProfileMenuOpen = false)"
          >
            <button
              @click="isProfileMenuOpen = !isProfileMenuOpen"
              class="relative w-10 h-10 rounded-full p-[2px] bg-gradient-to-tr from-[#00E5FF]/20 to-[#00E5FF] active:scale-90 transition-transform shadow-[0_0_15px_rgba(0,229,255,0.2)]"
            >
              <div
                class="w-full h-full rounded-full bg-[#131313] overflow-hidden"
              >
                <img
                  alt="User Profile"
                  class="w-full h-full object-cover"
                  :src="userAvatar"
                />
              </div>
            </button>

            <transition name="dropdown">
              <div
                v-if="isProfileMenuOpen"
                class="absolute top-12 right-0 w-60 bg-[#1A1A1A] border border-white/10 rounded-2xl shadow-2xl py-2 z-[110] backdrop-blur-2xl"
              >
                <button
                  @click="handleMenuNavigation('/profile')"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group w-full text-left"
                >
                  <span
                    class="material-symbols-outlined text-primary-container text-[20px]"
                    >account_circle</span
                  >
                  <span class="text-xs font-medium text-on-surface">{{
                    $t("appLayout.profileMenu.my_profile")
                  }}</span>
                </button>

                <button
                  @click="handleMenuNavigation('/audit/profile-fine-tuning')"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group w-full text-left"
                >
                  <span
                    class="material-symbols-outlined text-primary-container text-[20px]"
                    >tune</span
                  >
                  <span class="text-xs font-medium text-on-surface">{{
                    $t("appLayout.profileMenu.agent_fine_tuning")
                  }}</span>
                </button>

                <button
                  @click="handleMenuNavigation('/audit/source-manager')"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group w-full text-left"
                >
                  <span
                    class="material-symbols-outlined text-primary-container text-[20px]"
                    >hub</span
                  >
                  <span class="text-xs font-medium text-on-surface">{{
                    $t("appLayout.profileMenu.source_manager")
                  }}</span>
                </button>

                <div class="h-px bg-white/5 w-full my-1"></div>

                <button
                  @click="openLogoutModal"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-error/10 text-error w-full text-left group"
                >
                  <span class="material-symbols-outlined text-[20px]"
                    >logout</span
                  >
                  <span class="text-xs font-medium">{{
                    $t("appLayout.profileMenu.logout")
                  }}</span>
                </button>
              </div>
            </transition>
          </div>
        </header>
      </div>

      <main class="pt-[60px] pb-28 w-full">
        <slot />
      </main>

      <nav
        class="fixed bottom-0 inset-x-0 mx-auto w-full max-w-2xl bg-[#131313]/95 backdrop-blur-xl border-t border-white/5 z-[100] pb-safe"
      >
        <div class="flex justify-around items-center h-16 w-full px-2">
          <button
            v-for="item in navItems"
            :key="item.path"
            @click="navigate.push(item.path)"
            class="flex flex-col items-center justify-center w-full h-full gap-1 transition-colors"
            :class="[
              route.path.includes(item.path)
                ? 'text-[#00E5FF]'
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import defaultAvatar from "~/assets/images/default_avatar.png";
import { $api } from "~/utils/api";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const route = useRoute();
const navigate = useSovereignNavigate();
const userAvatar = ref(defaultAvatar);

const authStore = useAuthStore();
const agentStore = useAgentStore();

const isProfileMenuOpen = ref(false);
const isLogoutModalOpen = ref(false);

const navItems = computed(() => [
  {
    label: t("appLayout.navigation.feed"),
    icon: "auto_awesome_motion",
    path: "/dashboard",
  },
  { label: t("appLayout.navigation.saved"), icon: "bookmark", path: "/saved" },
  { label: t("appLayout.navigation.shared"), icon: "share", path: "/shared" },
  {
    label: t("appLayout.navigation.trends"),
    icon: "insights",
    path: "/trends",
  },
]);

const handleMenuNavigation = (path: string) => {
  isProfileMenuOpen.value = false;
  navigate.push(path);
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

  if (process.client) {
    localStorage.removeItem("nusift_visited");
    sessionStorage.clear();

    // Hard-redirect a bejelentkező oldalra
    window.location.href = "/auth";
  }
};

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
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.95);
}
</style>
