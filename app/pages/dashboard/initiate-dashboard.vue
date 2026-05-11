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
          <div class="flex items-center group transition-all duration-300">
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
          </div>
          <div class="flex items-center gap-4 relative">
            <div
              class="w-9 h-9 rounded-full overflow-hidden transition-all duration-300"
              :class="{
                'opacity-50 grayscale cursor-not-allowed border-outline':
                  isDisabled,
                'border-primary': !isDisabled,
              }"
              :style="
                !isDisabled
                  ? 'border: 2px solid #00e5ff'
                  : 'border: 2px solid #444'
              "
            >
              <img
                alt="User Profile"
                class="w-full h-full object-cover"
                :src="userAvatar"
              />
            </div>
          </div>
        </header>
      </div>

      <main class="px-4 space-y-3 max-w-2xl mx-auto pt-[100px]">
        <section
          class="flex flex-col items-center justify-center text-center py-12 px-6 space-y-6 bg-surface-container-low/80 backdrop-blur-md rounded-3xl border border-primary-container/10 shadow-[0_0_40px_rgba(0,229,255,0.05)] overflow-hidden"
        >
          <div
            class="w-20 h-20 bg-primary-container/10 rounded-full flex items-center justify-center mb-2"
            :class="{ 'animate-fast-pulse': isSifting }"
          >
            <span
              class="material-symbols-outlined text-4xl text-[#00E5FF]"
              :style="{ fontVariationSettings: '\'FILL\' 1' }"
              >radar</span
            >
          </div>
          <h1
            class="font-headline font-bold text-3xl text-[#00E5FF] leading-tight"
          >
            Your Horizon is Ready.
          </h1>
          <p
            class="text-sm font-body text-on-surface-variant leading-relaxed max-w-md mx-auto"
          >
            Your agents have been deployed and your interests mapped. Click the
            button below to perform your first deep sift and generate your
            curated feed.
          </p>
          <button
            @click="initiateSift"
            :disabled="isSifting"
            class="mt-4 flex items-center gap-3 bg-gradient-to-r from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-bold py-4 px-8 rounded-full shadow-[0_8px_32px_rgba(0,229,255,0.3)] transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              v-if="!isSifting"
              class="material-symbols-outlined"
              :style="{ fontVariationSettings: '\'FILL\' 1' }"
              >auto_awesome</span
            >
            <span
              v-else
              class="animate-spin h-4 w-4 border-2 border-[#131313] border-t-transparent rounded-full"
            ></span>
            <span class="uppercase tracking-wider text-sm"
              >Initiate First Sift</span
            >
          </button>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import defaultAvatar from "~/assets/images/default_avatar.png";

const isDisabled = ref(true);
const router = useRouter();
const userAvatar = ref(defaultAvatar);
const isSifting = ref(false);

const initiateSift = () => {
  if (isSifting.value) return;

  isSifting.value = true;

  setTimeout(() => {
    isSifting.value = false;
    router.replace("/dashboard");
  }, 2500);
};
</script>

<style scoped>
@keyframes fast-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2);
  }
}
.animate-fast-pulse {
  animation: fast-pulse 0.5s ease-in-out infinite;
}
.profile-disabled {
  filter: grayscale(100%) brightness(0.6);
  opacity: 0.4;
  border-color: #333 !important;
}
</style>
