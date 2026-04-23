<template>
  <div class="min-h-screen bg-background text-on-background font-body selection:bg-primary-container/30 relative overflow-hidden">
    
    <!-- Auth Preloader Overlay -->
    <div
      v-if="isLoading"
      class="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background/90 backdrop-blur-md"
    >
      <div class="relative flex items-center justify-center mb-6">
        <div class="absolute w-16 h-16 border-4 border-primary/20 rounded-full"></div>
        <div class="absolute w-16 h-16 border-4 border-t-primary rounded-full animate-spin"></div>
        <span class="material-symbols-outlined text-primary text-3xl animate-pulse">sync</span>
      </div>
      <p class="font-headline text-lg font-medium tracking-wide text-on-surface">
        Synchronizing Credentials...
      </p>
    </div>

    <!-- Main Content Canvas -->
    <main class="min-h-screen flex flex-col items-center justify-center px-6 py-12 relative overflow-hidden">
      
      <!-- Atmospheric Background Element -->
      <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-surface-tint/5 rounded-full blur-[120px] -z-10"></div>
      
      <!-- Container Card -->
      <div class="w-full max-w-md flex flex-col items-center text-center relative z-10">
        
        <!-- Logo Section -->
        <div class="relative w-[120px] h-[120px] mb-12 mx-auto">
          <div class="absolute inset-0 bg-primary-container/10 blur-2xl rounded-full"></div>
          <div class="relative flex items-center justify-center w-full h-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden rounded-xl shadow-2xl">
            <img alt="NuSift logo" class="w-full h-full object-cover" src="~/assets/images/NuSift_Logo_Blue.png"/>
          </div>
        </div>

        <!-- Typography Clustered -->
        <div class="space-y-4 mb-5">
          <h1 class="font-lg text-4xl font-bold tracking-tight text-on-surface">
            Check your inbox
          </h1>
          <p class="font-body text-medium text-on-surface-variant leading-relaxed max-w-sm mx-auto px-2">
            We've sent a Verification Link to your email. Click the link in the email to automatically confirm your account.
          </p>
        </div>

        <!-- Deep-Link Awaiting State -->
        <div class="flex items-center justify-center gap-3 mb-8 py-2 px-2 rounded-full bg-surface-container-low border border-outline-variant/10">
          <div class="relative flex h-3 w-3">
            <div class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></div>
            <div class="relative inline-flex rounded-full h-3 w-3 bg-primary"></div>
          </div>
          <span class="text-sm font-label font-medium text-on-surface-variant tracking-wide">Awaiting automatic verification...</span>
        </div>

        <!-- Action Cluster -->
        <div class="w-full space-y-6">
          <div class="space-y-3">
            <p class="text-[10px] text-outline font-label font-bold uppercase tracking-[0.2em]">Fallback Options</p>
            
            <!-- Demoted Action Button -->
            <button 
              @click="simulateAction('verify')" 
              :disabled="isLoading" 
              class="w-full bg-primary-container text-on-primary-container font-headline font-bold py-4 rounded-xl shadow-lg hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-base mt-4 uppercase tracking-widest"
            >
              I've Verified My Email
            </button>
          </div>
          
          <!-- Secondary Action -->
          <div class="pt-1">
            <button 
              @click="simulateAction('resend')" 
              :disabled="isLoading" 
              class="font-label text-sm font-medium text-on-surface-variant hover:text-primary transition-colors py-2 px-4 rounded-lg hover:bg-surface-bright/20 flex items-center justify-center gap-2 mx-auto disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span class="material-symbols-outlined text-[18px]">refresh</span>
              Resend Verification Link
            </button>
          </div>
        </div>

        <!-- Status Card (Bento-style element) -->
        <div class="mt-5 p-5 w-full bg-surface-container rounded-2xl flex items-start gap-4 text-left border border-outline-variant/10">
          <div class="p-2 rounded-full bg-surface-container-highest text-primary">
            <span class="material-symbols-outlined">info</span>
          </div>
          <div class="flex-1">
            <p class="text-xs font-label uppercase tracking-widest text-primary mb-1">Notice</p>
            <p class="text-sm text-on-surface-variant leading-snug">
              It may take a few minutes for the email to arrive. Please check your spam or junk folder if you don't see it.
            </p>
          </div>
        </div>
      </div>

      <!-- Footer Support -->
      <footer class="absolute bottom-10 left-0 w-full flex justify-center z-10">
        <p class="font-label text-xs text-on-surface-variant/60 flex items-center gap-1">
          Need help? 
          <a class="text-on-surface-variant hover:text-primary underline underline-offset-4 decoration-outline-variant transition-colors" href="#">Contact support</a>
        </p>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "nuxt/app";

const router = useRouter();
const isLoading = ref(false);

const simulateAction = async (type: "verify" | "resend") => {
  isLoading.value = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (type === "verify") {
      router.push("/");
    } else if (type === "resend") {
      alert("New Link Sent. Please check your inbox.");
    }
  } finally {
    isLoading.value = false;
  }
};
</script>
