<template>
  <div class="bg-background text-on-background min-h-screen pb-28 font-body">
    <div
      class="fixed top-0 left-0 w-full z-50 bg-gradient-to-b from-[#131313] via-[#131313] to-surface-container-low shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
    >
      <header class="flex justify-between items-center px-6 py-3 w-full">
        <div class="flex items-center flex-nowrap">
          <img
            alt="NuSift Logo"
            class="object-contain w-1/3"
            src="~/assets/images/NuSift_Transparent_Logo.png"
          />
          <span
            class="text-[#00E5FF] font-medium ml-4 border-l-2 border-[#00E5FF]/40 pl-4 leading-tight uppercase tracking-wider font-label text-[10px] block flex-shrink-0"
          >
            AI Filtering.<br />Guided by Your Hand.
          </span>
        </div>
        <div class="flex items-center gap-4">
          <div
            class="w-9 h-9 rounded-full overflow-hidden"
            style="border: 2px solid #00e5ff"
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
          button below to perform your first deep sift and generate your curated
          feed.
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

    <nav
      class="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-5 pt-2 bg-[#1c1b1b]/80 backdrop-blur-xl shadow-[0_-4px_24px_rgba(0,229,255,0.08)] rounded-t-[28px]"
    >
      <a
        class="flex flex-col items-center justify-center text-[#c3f5ff] bg-[#353534]/50 rounded-xl px-3 py-1.5 transition-all duration-300 pointer-events-none"
        href="#"
      >
        <span
          class="material-symbols-outlined text-xl"
          :style="{ fontVariationSettings: '\'FILL\' 1' }"
          >newspaper</span
        >
        <span class="font-label text-[10px] font-medium mt-0.5">News</span>
      </a>
      <a
        class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 opacity-50 cursor-not-allowed pointer-events-none transition-all"
        href="#"
      >
        <span class="material-symbols-outlined text-xl">bookmarks</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Saved</span>
      </a>
      <a
        class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 opacity-50 cursor-not-allowed pointer-events-none transition-all"
        href="#"
      >
        <span class="material-symbols-outlined text-xl">share</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Shared</span>
      </a>
      <a
        class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 opacity-50 cursor-not-allowed pointer-events-none transition-all"
        href="#"
      >
        <span class="material-symbols-outlined text-xl">trending_up</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Trends</span>
      </a>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import defaultAvatar from '~/assets/images/default_avatar.png';

const router = useRouter();
const userAvatar = ref(defaultAvatar);
const isSifting = ref(false);

const initiateSift = () => {
  if (isSifting.value) return;

  isSifting.value = true;

  setTimeout(() => {
    isSifting.value = false;
    router.push("/dashboard");
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
</style>
