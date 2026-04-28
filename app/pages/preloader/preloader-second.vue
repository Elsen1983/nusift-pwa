<template>
  <div
    class="bg-surface text-on-surface font-body overflow-hidden min-h-screen relative selection:bg-primary-container selection:text-on-primary-container"
  >
    <div class="fixed inset-0 pointer-events-none z-0">
      <div
        class="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-primary-container/10 blur-[120px]"
      ></div>
      <div
        class="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] rounded-full bg-secondary-container/5 blur-[120px]"
      ></div>
    </div>

    <main
      class="relative z-20 h-screen w-full flex flex-col items-center justify-center px-6"
    >
      <div class="w-full max-w-md flex flex-col items-center">
        <div
          class="relative p-6 border border-outline-variant/10 rounded-xl bg-surface-container-low/20 backdrop-blur-md mb-12"
        >
          <div
            class="absolute inset-0 rounded-xl border border-[#00E5FF]/20 animate-[pulse-ring_4s_cubic-bezier(0.4,0,0.6,1)_infinite]"
          ></div>
          <div
            class="absolute inset-2 rounded-lg border border-[#00E5FF]/10 animate-[pulse-ring_4s_cubic-bezier(0.4,0,0.6,1)_infinite_1s]"
          ></div>

          <div
            class="w-48 h-48 flex items-center justify-center animate-[pulse-logo_4s_cubic-bezier(0.4,0,0.6,1)_infinite]"
          >
            <span class="material-symbols-outlined text-6xl text-[#00E5FF]"
              >satellite_alt</span
            >
          </div>
        </div>

        <div class="w-full flex flex-col items-center max-w-xs">
          <span
            class="font-headline text-[10px] tracking-[0.3em] text-primary mb-4 uppercase"
            >FORGING INTELLIGENCE HORIZON...</span
          >

          <div
            class="w-full h-[2px] bg-surface-container-highest rounded-full overflow-hidden relative"
          >
            <div
              class="absolute top-0 left-0 h-full w-1/3 bg-gradient-to-r from-transparent via-primary-container to-transparent animate-[progress-loading_2.5s_infinite_linear] shadow-[0_0_15px_rgba(0,229,255,0.6)]"
            ></div>
          </div>
        </div>

        <div
          class="mt-16 text-center h-20 flex flex-col items-center justify-center max-w-sm px-4"
        >
          <transition
            mode="out-in"
            enter-active-class="transition-all duration-1000 ease-out"
            enter-from-class="opacity-0 translate-y-2"
            leave-active-class="transition-all duration-1000 ease-in"
            leave-to-class="opacity-0 -translate-y-2"
          >
            <div :key="currentQuoteIndex" class="space-y-3">
              <p
                class="font-body text-base text-on-surface-variant leading-relaxed italic"
              >
                “{{ currentQuote.text }}”
              </p>
              <p
                v-if="currentQuote.author"
                class="font-label text-[11px] uppercase tracking-widest text-primary/70"
              >
                — {{ currentQuote.author }}
              </p>
            </div>
          </transition>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();

interface Quote {
  text: string;
  author: string;
}

// A preloader-second-ben használt idézet
const quotes: Quote[] = [
  {
    text: "When you sift through the noise, you don't just find information; you find clarity. And in clarity, you find your own path.",
    author: "",
  },
];

const currentQuoteIndex = ref(0);
let quoteInterval: ReturnType<typeof setInterval> | null = null;

const currentQuote = computed<Quote>(() => {
  return quotes[currentQuoteIndex.value] ?? (quotes[0] as Quote);
});

onMounted(() => {
  // Idézetek váltakozása (bár itt csak egy van, a struktúra megmarad)
  if (quotes.length > 1) {
    quoteInterval = setInterval(() => {
      currentQuoteIndex.value = (currentQuoteIndex.value + 1) % quotes.length;
    }, 4000);
  }

  // Preloader működése: 3.5 másodperc várakozás, majd továbbirányítás
  setTimeout(() => {
    // Továbbirányítás a korábban megbeszélt '/dashboard-initiate' útvonalra
    console.log("Preloader véget ért, továbbirányítás a dashboard-initiate oldalra...");
    router.push("/dashboard-initiate");
  }, 3500);
});

onBeforeUnmount(() => {
  if (quoteInterval) clearInterval(quoteInterval);
});
</script>

<style scoped>
@keyframes pulse-ring {
  0% {
    transform: scale(0.95);
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
  100% {
    transform: scale(1.05);
    opacity: 0;
  }
}
@keyframes pulse-logo {
  0%,
  100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}
@keyframes progress-loading {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}
</style>
