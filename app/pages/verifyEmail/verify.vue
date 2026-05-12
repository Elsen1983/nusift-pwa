<template>
  <div class="min-h-screen bg-background flex flex-col items-center justify-center relative">
    <div class="relative flex items-center justify-center mb-6">
      <div class="absolute w-16 h-16 border-4 rounded-full transition-colors duration-500" :class="isSuccess ? 'border-green-400/20' : 'border-primary/20'"></div>
      <div v-if="!isSuccess" class="absolute w-16 h-16 border-4 border-t-primary rounded-full animate-spin"></div>
      <span class="material-symbols-outlined text-3xl transition-colors duration-500" :class="isSuccess ? 'text-green-400' : 'text-primary animate-pulse'">
        {{ isSuccess ? 'check_circle' : 'lock_open' }}
      </span>
    </div>
    
    <h1 class="font-headline text-xl mb-2 transition-colors duration-500" :class="isSuccess ? 'text-green-400' : 'text-primary'">
      {{ isSuccess ? 'Identity Verified' : 'Decrypting Access Link...' }}
    </h1>
    
    <div v-if="isSuccess" class="flex flex-col items-center mt-4">
      <p class="text-on-surface-variant font-body text-center max-w-sm px-4 leading-relaxed mb-6">
        Authentication complete. You can safely close this tab and return to your original NuSift window to proceed.
      </p>
      
      <!-- Hibrid Webview Mentőöv -->
      <button 
        @click="continueInThisTab"
        class="text-xs font-label uppercase tracking-widest text-primary border border-primary/30 px-6 py-3 rounded-lg hover:bg-primary/10 transition-colors"
      >
        Or Continue Here
      </button>
    </div>

    <p v-if="errorMsg" class="text-error font-label mt-4 p-4 bg-error/10 rounded-lg border border-error/20">
      {{ errorMsg }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'nuxt/app';

const route = useRoute();
const router = useRouter();
const errorMsg = ref('');
const isSuccess = ref(false);

onMounted(async () => {
  const token = route.query.token;
  if (!token) {
    errorMsg.value = 'Missing verification signature.';
    return;
  }

  try {
    const response = await $fetch<any>('/api/auth/verify', {
      method: 'POST',
      body: { token }
    });
    if (response.success) {
      isSuccess.value = true;
    }
  } catch (err: any) {
    errorMsg.value = err.statusMessage || 'Verification failed. Link may be expired or already used.';
  }
});

const continueInThisTab = () => {
  // A Guard automatikusan meglátja a sütit és a kalibrációra dob
  // router.replace('/'); 
  window.location.href = "/"; // This forces a full page reload, ensuring the new session cookie is recognized immediately
};
</script>