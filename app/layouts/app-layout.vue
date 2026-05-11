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
          <NuxtLink
            to="/dashboard"
            class="flex items-center group transition-all duration-300"
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
                AI Filtering.<br />Guided by Your Hand.
              </span>
            </div>
          </NuxtLink>

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
                <NuxtLink
                  to="/profile"
                  @click="isProfileMenuOpen = false"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group"
                >
                  <span
                    class="material-symbols-outlined text-primary-container text-[20px]"
                    >account_circle</span
                  >
                  <span class="text-xs font-medium text-on-surface"
                    >My Profile</span
                  >
                </NuxtLink>

                <NuxtLink
                  to="/audit/profile-fine-tuning"
                  @click="isProfileMenuOpen = false"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group"
                >
                  <span
                    class="material-symbols-outlined text-primary-container text-[20px]"
                    >tune</span
                  >
                  <span class="text-xs font-medium text-on-surface"
                    >Agent Fine-Tuning</span
                  >
                </NuxtLink>

                <div class="h-px bg-white/5 w-full my-1"></div>

                <button
                  @click="openLogoutModal"
                  class="flex items-center gap-3 px-4 py-3 hover:bg-error/10 text-error w-full text-left group"
                >
                  <span class="material-symbols-outlined text-[20px]"
                    >logout</span
                  >
                  <span class="text-xs font-medium">Logout</span>
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
          <NuxtLink
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="flex flex-col items-center gap-1 group py-1"
            active-class="text-primary-container"
          >
            <span
              class="material-symbols-outlined text-[24px]"
              :class="{
                'text-primary-container drop-shadow-[0_0_8px_rgba(0,229,255,0.4)]':
                  $route.path === item.path,
                'text-on-surface-variant': $route.path !== item.path,
              }"
            >
              {{ item.icon }}
            </span>
            <span
              class="text-[10px] font-bold uppercase tracking-tighter"
              :class="{
                'text-primary-container': $route.path === item.path,
                'text-on-surface-variant': $route.path !== item.path,
              }"
            >
              {{ item.label }}
            </span>
          </NuxtLink>
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
import { ref } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useAgentStore } from "~/stores/agent";
import defaultAvatar from "~/assets/images/default_avatar.png";
const userAvatar = ref(defaultAvatar);

const authStore = useAuthStore();
const agentStore = useAgentStore();

const isProfileMenuOpen = ref(false);
const isLogoutModalOpen = ref(false);

const navItems = [
  { label: "Feed", icon: "auto_awesome_motion", path: "/dashboard" },
  { label: "Saved", icon: "bookmark", path: "/saved" },
  { label: "Shared", icon: "share", path: "/shared" },
  { label: "Trends", icon: "insights", path: "/trends" },
];

/**
 * Megnyitja a megerősítő ablakot és bezárja a profil menüt.
 */
const openLogoutModal = () => {
  isProfileMenuOpen.value = false;
  isLogoutModalOpen.value = true;
};

/**
 * ANCHOR SECURE-LOGOUT-REFACTORED
 * Tisztább, TS-hibáktól mentes logout protokoll.
 */
const handleSecureLogout = () => {
  // 1. Cookie-k törlése
  const token = useCookie("auth_token");
  token.value = null;

  // 2. Pinia Store manuális resetelése (void hiba elkerülése)
  if (typeof authStore.$reset === "function") {
    authStore.$reset();
  } else {
    // Setup Store esetén manuálisan ürítjük a reaktív állapotot
    authStore.user = null;
  }

  if (typeof agentStore.$reset === "function") {
    agentStore.$reset();
  }

  // 3. Kliens oldali extra takarítás
  if (process.client) {
    localStorage.removeItem("nusift_visited");
    sessionStorage.clear();
  }

  // 4. Hard redirect
  window.location.href = "/auth";
};

// Click Outside direktíva a profil menühöz
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
