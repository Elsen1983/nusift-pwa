<template>
  <div
    class="bg-surface text-on-surface font-body selection:bg-primary-container selection:text-on-primary-container min-h-screen relative z-0"
  >
    <div
      class="fixed top-0 right-0 w-[500px] h-[500px] bg-primary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>
    <div
      class="fixed bottom-0 left-0 w-[500px] h-[500px] bg-secondary-container/5 blur-[120px] rounded-full -z-10 pointer-events-none"
    ></div>

    <header
      class="fixed top-0 w-full z-50 flex items-center justify-between px-6 py-4 bg-[#131313]"
    >
      <div class="flex items-center gap-3">
        <span
          class="material-symbols-outlined text-[#00E5FF] cursor-pointer"
          @click="logoutAndGoBack"
          >arrow_back</span
        >
        <h1 class="font-headline tracking-tighter text-[#00E5FF]">
          Back to Login
        </h1>
      </div>
      <div class="hidden md:flex flex-col items-end">
        <span
          class="text-[10px] text-on-surface-variant font-label uppercase tracking-[0.2em]"
          >Sifting Progress</span
        >
        <div
          class="w-32 h-1 bg-surface-container-highest rounded-full mt-1 overflow-hidden"
        >
          <div
            class="h-full w-[33%] bg-primary-container shadow-[0_0_8px_rgba(0,229,255,0.5)]"
          ></div>
        </div>
      </div>
    </header>

    <main class="pt-24 pb-32 px-6 max-w-4xl mx-auto">
      <section class="mb-12">
        <div
          class="inline-block px-3 py-1 bg-surface-container-highest rounded-lg mb-4"
        >
          <span
            class="text-[10px] font-label font-bold text-primary tracking-widest uppercase"
            >Agent Deployment Phase</span
          >
        </div>
        <h2
          class="font-headline text-4xl md:text-5xl font-bold text-primary leading-tight tracking-tight mb-4"
        >
          Deploy Your Agents
        </h2>
        <p class="text-on-surface-variant text-lg max-w-2xl leading-relaxed">
          Enter the domains or site names you want NuSift to prioritize.
        </p>
      </section>

      <section class="mb-12 space-y-6">
        <div class="relative group">
          <label
            class="block text-[11px] font-label uppercase tracking-widest text-on-surface-variant mb-2 ml-1"
            >Manual Domain Entry</label
          >
          <div
            class="bg-surface-container-low p-1 rounded-xl transition-all duration-300 focus-within:shadow-[0_0_20px_rgba(0,229,255,0.05)]"
          >
            <input
              v-model="urlInput"
              class="w-full bg-surface-container-highest border-none rounded-lg text-on-surface placeholder:text-outline/50 focus:ring-1 focus:ring-primary-fixed/30 font-body h-[52px] text-sm px-4"
              placeholder="Paste URL (e.g., techcrunch.com)..."
              type="url"
            />
          </div>
          <p
            v-if="showUrlError"
            class="text-error text-[10px] font-label mt-1 ml-1"
          >
            {{
              serverErrorMsg
                ? serverErrorMsg
                : "Please enter a valid domain format."
            }}
          </p>
        </div>
        <div class="flex justify-end">
          <button
            @click="addSource"
            :disabled="!isValidUrl || isAdding"
            class="bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] font-bold px-8 rounded-xl flex items-center gap-2 hover:scale-[1.02] active:scale-95 transition-all shadow-[0_8px_20px_rgba(0,229,255,0.15)] group py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span v-if="!isAdding" class="material-symbols-outlined text-xl"
              >add</span
            >
            <span
              v-else
              class="animate-spin h-5 w-5 border-2 border-[#131313] border-t-transparent rounded-full"
            ></span>
            <span>Add to Monitoring List</span>
          </button>
        </div>
      </section>

      <section>
        <div class="flex items-center justify-between mb-6">
          <h3 class="font-headline text-xl text-primary font-medium">
            Active Monitoring List
          </h3>
          <span class="text-on-surface-variant font-label text-xs"
            >{{ sources.length }} Sources Active</span
          >
        </div>

        <div
          v-if="sources.length === 0"
          class="p-12 border-2 border-dashed border-outline-variant/30 rounded-2xl flex flex-col items-center text-center"
        >
          <span
            class="material-symbols-outlined text-outline-variant text-4xl mb-3"
            >cloud_off</span
          >
          <p class="text-on-surface-variant font-body">
            No sources added yet. Enter a domain above to begin.
          </p>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            v-for="(source, index) in sources"
            :key="index"
            class="bg-surface-container-low p-5 rounded-xl flex flex-col justify-between hover:bg-surface-container transition-colors group"
          >
            <div class="flex justify-between items-start mb-6">
              <div class="flex items-center gap-3">
                <div
                  class="w-10 h-10 bg-surface-container-highest rounded-full flex items-center justify-center text-primary-container"
                >
                  <span class="material-symbols-outlined">language</span>
                </div>
                <div>
                  <h4 class="font-bold text-primary">{{ source }}</h4>
                  <p
                    class="text-[10px] text-on-surface-variant font-label uppercase tracking-wider"
                  >
                    Direct URL Feed
                  </p>
                </div>
              </div>
              <button
                @click="promptDelete(index)"
                class="text-on-surface-variant hover:text-error transition-colors"
              >
                <span class="material-symbols-outlined text-xl">delete</span>
              </button>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span
                  class="w-2 h-2 rounded-full bg-primary-container animate-pulse"
                ></span>
                <span class="text-[#00E5FF] font-label text-xs font-semibold"
                  >Ready for Sifting</span
                >
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <nav
      class="fixed bottom-0 left-0 w-full z-50 flex items-center px-8 pb-8 pt-4 bg-[#201f1f]/80 backdrop-blur-xl rounded-t-3xl shadow-[0_-4px_24px_rgba(0,229,255,0.08)] justify-end"
    >
      <button
        @click="saveAndContinue"
        :disabled="sources.length === 0"
        class="flex items-center gap-3 px-6 py-3 rounded-xl transition-all group bg-gradient-to-br from-[#c3f5ff] to-[#00e5ff] text-[#131313] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span class="font-headline font-bold">Next: Map My Interests</span>
        <span
          class="material-symbols-outlined group-hover:translate-x-1 transition-transform"
          >arrow_forward</span
        >
      </button>
    </nav>

    <div
      v-if="showModal"
      class="fixed inset-0 z-[100] flex items-center justify-center px-6 bg-surface/80 backdrop-blur-sm"
    >
      <div
        class="bg-surface-container p-6 rounded-2xl w-full max-w-sm border border-outline-variant/20 shadow-2xl"
      >
        <h4 class="font-headline text-xl text-primary font-bold mb-2">
          Remove this source?
        </h4>
        <div class="flex gap-3 mt-6">
          <button
            @click="showModal = false"
            class="flex-1 py-3 rounded-xl border border-outline-variant text-on-surface hover:bg-surface-bright"
          >
            Cancel
          </button>
          <button
            @click="confirmDelete"
            class="flex-1 py-3 rounded-xl bg-error text-on-error font-bold hover:brightness-110"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "~/stores/auth";

const router = useRouter();
const authStore = useAuthStore();

const urlInput = ref("");
const isAdding = ref(false);
const isSaving = ref(false);
const sources = ref<string[]>([]);
const showModal = ref(false);
const sourceToDelete = ref<number | null>(null);
const serverErrorMsg = ref("");

const domainRegex = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;

const isValidUrl = computed(() => domainRegex.test(urlInput.value.trim()));
const showUrlError = computed(
  () =>
    (urlInput.value.trim() !== "" && !isValidUrl.value) ||
    serverErrorMsg.value !== "",
);

const logoutAndGoBack = async () => {
  await authStore.logoutIdentity();
  router.push('/auth');
};

const addSource = async () => {
  if (!isValidUrl.value || isAdding.value) return;

  isAdding.value = true;
  serverErrorMsg.value = ""; 

  try {
    const response = await $fetch<any>("/api/util/verify-source", {
      method: "POST",
      body: { url: urlInput.value },
    });

    if (response.success) {
      if (!sources.value.includes(response.url)) {
        sources.value.push(response.url);
      }
      urlInput.value = ""; 
    } else {
      serverErrorMsg.value = response.message || "Hálózat: Nem létező weboldal.";
    }
  } catch (err) {
    serverErrorMsg.value = "Hiba történt a validálás során.";
  } finally {
    isAdding.value = false;
  }
};

const promptDelete = (index: number) => {
  sourceToDelete.value = index;
  showModal.value = true;
};

const confirmDelete = () => {
  if (sourceToDelete.value !== null) {
    sources.value.splice(sourceToDelete.value, 1);
  }
  showModal.value = false;
  sourceToDelete.value = null;
};

const saveAndContinue = async () => {
  isSaving.value = true;
  
  // TODO: Majd itt hívjuk a backendet, ami elmenti a source-okat és átállítja az onboardingStep-et 1-re
  setTimeout(() => {
    if (authStore.user) {
      authStore.user.onboardingStep = 1;
      
      // Update PWA offline profile
      if (!import.meta.server) {
        localStorage.setItem('nusift_pwa_profile', JSON.stringify(authStore.user));
      }
    }
    router.push("/interest-calibration");
  }, 1000);
};
</script>