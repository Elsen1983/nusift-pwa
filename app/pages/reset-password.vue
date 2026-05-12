<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container relative overflow-hidden flex flex-col items-center justify-center px-8 py-6">
    
    <div class="fixed top-[-5%] left-[-5%] w-[40%] h-[30%] bg-primary-container/5 blur-[100px] rounded-full -z-10 pointer-events-none"></div>
    <div class="fixed bottom-[0%] right-[-5%] w-[30%] h-[25%] bg-secondary-container/5 blur-[80px] rounded-full -z-10 pointer-events-none"></div>

    <main class="w-full max-w-md mx-auto relative z-10">
      <section class="flex flex-col items-center mb-8">
        <div class="relative w-[100px] h-[100px] mb-4 shadow-xl rounded-xl">
          <div class="absolute inset-0 bg-primary-container/10 blur-xl rounded-full"></div>
          <div class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl">
            <span class="material-symbols-outlined text-4xl text-primary-container">lock_reset</span>
          </div>
        </div>
        <h1 class="font-headline text-3xl font-bold tracking-tight text-on-surface text-center">
          Update Security Key
        </h1>
        <p class="text-[11px] text-on-surface-variant mt-2 font-label uppercase tracking-[0.25em] text-center opacity-80">
          Enter a new Sovereign-Grade password
        </p>
      </section>

      <section class="w-full">
        <div v-if="successMessage" class="mb-6 p-4 bg-primary-container/10 border border-primary-container/30 rounded-xl text-center">
          <span class="material-symbols-outlined text-[#00E5FF] text-4xl mb-2">check_circle</span>
          <p class="text-sm font-body text-[#00E5FF] leading-relaxed">{{ successMessage }}</p>
          <NuxtLink to="/auth" class="mt-4 inline-block px-6 py-2 bg-primary-container text-on-primary-container font-headline font-bold rounded-lg text-xs uppercase tracking-widest hover:brightness-110 transition-all">
            Return to Login
          </NuxtLink>
        </div>

        <form v-else @submit.prevent="submitNewPassword" class="space-y-4">
          <BaseInput
            v-model="newPassword"
            label="New Password"
            type="password"
            placeholder="••••••••••••"
            :error="passwordError"
            @blur="validatePasswords"
          />
          <BaseInput
            v-model="confirmPassword"
            label="Confirm Password"
            type="password"
            placeholder="••••••••••••"
            :error="confirmError"
            @blur="validatePasswords"
          />

          <p v-if="serverError" class="text-xs font-label text-red-500 mt-2">{{ serverError }}</p>

          <button
            type="submit"
            :disabled="isLoading || !!passwordError || !!confirmError || !newPassword || !confirmPassword"
            class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-3 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-base mt-4 uppercase tracking-widest"
          >
            {{ isLoading ? "Encrypting..." : "Confirm New Password" }}
          </button>
        </form>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const token = ref<string | null>(null);

const newPassword = ref('');
const confirmPassword = ref('');
const passwordError = ref('');
const confirmError = ref('');
const serverError = ref('');
const successMessage = ref('');
const isLoading = ref(false);

onMounted(() => {
  // Capture the token from the URL query parameters
  if (route.query.token && typeof route.query.token === 'string') {
    token.value = route.query.token;
  } else {
    serverError.value = "Security token is missing from the URL. Please request a new reset link.";
  }
});

const validatePasswords = () => {
  passwordError.value = "";
  confirmError.value = "";

  if (newPassword.value && newPassword.value.length < 12) {
    passwordError.value = "Security fail: Minimum 12 characters required.";
  }
  if (confirmPassword.value && newPassword.value !== confirmPassword.value) {
    confirmError.value = "Passwords do not match.";
  }
};

watch([newPassword, confirmPassword], () => {
  if (passwordError.value || confirmError.value) {
    validatePasswords();
  }
});

const submitNewPassword = async () => {
  validatePasswords();
  if (passwordError.value || confirmError.value || !token.value) return;

  isLoading.value = true;
  serverError.value = "";

  try {
    const response = await $fetch<any>('/api/auth/reset-password', {
      method: 'POST',
      body: { 
        token: token.value, 
        newPassword: newPassword.value 
      }
    });

    successMessage.value = response.message;
  } catch (error: any) {
    serverError.value = error.data?.statusMessage || "Failed to reset password. The link may have expired.";
  } finally {
    isLoading.value = false;
  }
};
</script>