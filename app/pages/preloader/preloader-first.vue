<template>
  <div
    class="min-h-screen bg-surface text-on-surface font-body selection:bg-primary-container selection:text-on-primary-container flex items-center justify-center overflow-hidden relative"
  >
    <div class="fixed inset-0 pointer-events-none overflow-hidden z-0">
      <div
        class="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-primary-container/5 blur-[120px]"
      ></div>
      <div
        class="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] rounded-full bg-secondary-container/10 blur-[150px]"
      ></div>
    </div>

    <main
      class="relative z-10 flex flex-col items-center justify-center w-full max-w-lg px-8 text-center -mt-24"
    >
      <div class="w-full flex flex-col items-center mb-6">
        <div class="relative w-[125px] h-[125px] mb-6">
          <div
            class="absolute inset-0 bg-primary-container/10 blur-2xl rounded-full"
          ></div>
          <div
            class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl"
          >
            <img
              src="~/assets/images/NuSift_Logo_Blue.png"
              alt="NuSift Logo"
              class="w-full h-full object-cover"
            />
          </div>
        </div>

        <!-- <div class="marquee-container mb-2">
          <div class="marquee-content">
            <span class="marquee-item">Crystal Clear Insights</span>
            <span class="marquee-item">Sovereign Truth</span>
            <span class="marquee-item">Unbiased Information</span>
            <span class="marquee-item">The Future of Curation</span>
            <span class="marquee-item">Verified Knowledge</span>
          </div>
        </div> -->
      </div>

      <div
        class="w-full min-h-[140px] flex items-center justify-center mb-8 px-4 relative"
      >
        <transition name="quote" mode="out-in">
          <div :key="currentQuote.text" class="absolute w-full">
            <p
              class="font-headline text-lg italic text-on-surface-variant leading-relaxed"
            >
              "{{ currentQuote.text }}"
            </p>
            <p
              class="font-label text-[11px] uppercase tracking-widest mt-3 text-primary-container/80"
            >
              — {{ currentQuote.author }}
            </p>
          </div>
        </transition>
      </div>

      <div class="w-full space-y-8">
        <div class="relative">
          <div
            class="h-[8px] w-full bg-surface-container-highest rounded-full overflow-hidden"
          >
            <div
              class="absolute top-0 h-[8px] bg-primary-container shadow-[0_0_12px_#00ffff] loading-bar-logic"
            ></div>
          </div>
          <div class="flex justify-between items-center mt-4 px-1">
            <span
              class="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60"
            >
              System Initialization
            </span>
            <span
              class="font-label text-[10px] uppercase tracking-[0.2em] text-primary-container"
            >
              Processing...
            </span>
          </div>
        </div>

        <div class="space-y-3">
          <p
            class="font-headline text-lg md:text-xl font-light text-on-surface tracking-wide leading-relaxed"
          >
            Curating your informational horizon...
          </p>
          <div class="flex items-center justify-center gap-4 opacity-40">
            <div class="h-px w-8 bg-outline-variant"></div>
            <span
              class="font-label text-[9px] uppercase tracking-[0.4em] text-on-surface-variant"
            >
              Version 2.4.0-Alpha
            </span>
            <div class="h-px w-8 bg-outline-variant"></div>
          </div>
        </div>
      </div>
    </main>

    <footer class="fixed bottom-12 w-full text-center z-10 mb-5 pb-5">
      <div
        class="inline-flex items-center gap-3 px-6 py-2 rounded-full border border-outline-variant/15 bg-surface-container/40 backdrop-blur-sm"
      >
        <div
          class="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse"
        ></div>
        <p
          class="font-label text-[11px] uppercase tracking-widest text-on-surface-variant"
        >
          Securing your digital sovereignty
        </p>
      </div>
    </footer>

    <div
      class="fixed bottom-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary-container/20 to-transparent z-10"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useRouter } from "vue-router";

const router = useRouter();
const authStore = useAuthStore();

interface Quote {
  text: string;
  author: string;
}

const quotes: Quote[] = [
  {
    text: "In a time of deceit, telling the truth is a revolutionary act.",
    author: "George Orwell",
  },
  { text: "The truth is rarely pure and never simple.", author: "Oscar Wilde" },
  {
    text: "Information is the currency of democracy.",
    author: "Thomas Jefferson",
  },
  {
    text: "A lie can travel half way around the world while the truth is putting on its shoes.",
    author: "Mark Twain",
  },
];

const currentQuoteIndex = ref(0);
let quoteInterval: ReturnType<typeof setInterval> | null = null;

const currentQuote = computed<Quote>(() => {
  return quotes[currentQuoteIndex.value] ?? (quotes[0] as Quote);
});

onMounted(() => {
  // Idézetek váltakozása
  quoteInterval = setInterval(() => {
    currentQuoteIndex.value = (currentQuoteIndex.value + 1) % quotes.length;
  }, 4000);

  // Preloader animáció futása
  setTimeout(() => {
    const step = authStore.user?.onboardingStep || 0;

    // Routing az állapot alapján
    if (step === 0) {
      router.replace("/region-calibration");
    } else if (step === 1) {
      router.replace("/interest-calibration");
    } else if (step === 2) {
      router.replace("/source-calibration");
    } else if (step >= 3) {
      router.replace("/dashboard");
    } else {
      // Fallback
      router.replace("/region-calibration");
    }
  }, 3500); // <-- FIX: Properly closing the setTimeout with 3.5s delay
}); // <-- FIX: Properly closing onMounted

onBeforeUnmount(() => {
  if (quoteInterval) clearInterval(quoteInterval);
});
</script>

<style scoped>
/* Vue native transition classes for the quote cycler */
.quote-enter-active,
.quote-leave-active {
  transition: all 0.8s cubic-bezier(0.4, 0, 0.2, 1);
}
.quote-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.quote-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* Custom pulse for the high-tech loader */
@keyframes tech-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
    filter: blur(0px);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.05);
    filter: blur(2px);
  }
}
.animate-tech-pulse {
  animation: tech-pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* High-fidelity progress bar animation simulation */
@keyframes loading-bar {
  0% {
    width: 0%;
    left: 0%;
  }
  50% {
    width: 30%;
    left: 70%;
  }
  100% {
    width: 0%;
    left: 100%;
  }
}
.loading-bar-logic {
  animation: loading-bar 2s ease-in-out infinite;
}

/* Marquee Animations */
@keyframes marquee-scroll {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-100%);
  }
}
.marquee-container {
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  position: relative;
  display: flex;
  align-items: center;
  height: 3rem;
}
.marquee-content {
  display: inline-block;
  padding-left: 100%;
  animation: marquee-scroll 15s linear infinite;
}
.marquee-item {
  display: inline-block;
  margin-right: 4rem;
  color: #00ffff; /* primary-container color override */
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 0.875rem;
  font-weight: 500;
  opacity: 0.8;
}
</style>
