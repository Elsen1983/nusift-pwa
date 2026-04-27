<template>
  <div class="bg-background text-on-background min-h-screen font-body">
    <div class="fixed top-0 left-0 w-full bg-[#131313] z-[100]">
      <header class="flex justify-between items-center px-6 py-3 w-full h-[60px]">
        <div class="flex items-center flex-nowrap">
          <img alt="NuSift Logo" class="object-contain w-1/3 max-w-[120px]" src="~/assets/images/NuSift_Transparent_Logo.png"/>
          <span class="text-[#00E5FF] font-medium ml-4 border-l-2 border-[#00E5FF]/40 pl-4 leading-tight uppercase tracking-wider font-label text-[10px] block flex-shrink-0">
            AI Filtering.<br/>Guided by Your Hand.
          </span>
        </div>
        
        <div class="flex items-center gap-4 relative" v-click-outside="() => isProfileMenuOpen = false">
          
          <button 
            @click="isProfileMenuOpen = !isProfileMenuOpen" 
            class="w-9 h-9 rounded-full overflow-hidden focus:outline-none transition-transform active:scale-95" 
            style="border: 2px solid #00E5FF;"
          >
           <img alt="User Profile" class="w-full h-full object-cover" :src="userAvatar"/>
          </button>
          
          <transition 
            enter-active-class="transition duration-200 ease-out" 
            enter-from-class="opacity-0 scale-95" 
            enter-to-class="opacity-100 scale-100" 
            leave-active-class="transition duration-100 ease-in" 
            leave-from-class="opacity-100 scale-100" 
            leave-to-class="opacity-0 scale-95"
          >
            <div 
              v-show="isProfileMenuOpen" 
              class="absolute top-12 right-0 w-56 bg-surface-container-highest border border-outline-variant/20 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[110] flex flex-col py-2 origin-top-right"
            >
              <div class="px-4 py-3 border-b border-outline-variant/20 mb-1">
                <p class="text-sm font-headline font-bold text-on-surface">Norbert Korom</p>
                <p class="text-xs font-body text-on-surface-variant truncate">norbertkorom@gmail.com</p>
              </div>

              <NuxtLink to="/profile" class="flex items-center gap-3 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group" @click="isProfileMenuOpen = false">
                <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">person</span>
                <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">My Profile</span>
              </NuxtLink>
              
              <NuxtLink to="/audit/profile-fine-tuning" class="flex items-center gap-3 px-4 py-2 hover:bg-surface-bright transition-colors text-left w-full group" @click="isProfileMenuOpen = false">
                <span class="material-symbols-outlined text-on-surface-variant text-[20px] group-hover:text-primary-container">tune</span>
                <span class="text-xs font-medium text-on-surface-variant group-hover:text-primary-container">Agent Fine-Tuning</span>
              </NuxtLink>

              <div class="h-px bg-outline-variant/20 w-full my-1"></div>
              
              <button class="flex items-center gap-3 px-4 py-2 hover:bg-error/10 transition-colors text-left w-full group" @click="isProfileMenuOpen = false">
                <span class="material-symbols-outlined text-error text-[20px]">logout</span>
                <span class="text-xs font-medium text-error">Logout</span>
              </button>
            </div>
          </transition>
        </div>
      </header>
    </div>

    <div class="pt-[60px] pb-28">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const userAvatar = ref('https://lh3.googleusercontent.com/a/default-user=s96-c');

const isProfileMenuOpen = ref(false);

const vClickOutside = {
  mounted(el: any, binding: any) {
    el.clickOutsideEvent = function (event: Event) {
      if (!(el === event.target || el.contains(event.target))) {
        binding.value(event, el);
      }
    };
    document.body.addEventListener('click', el.clickOutsideEvent);
  },
  unmounted(el: any) {
    document.body.removeEventListener('click', el.clickOutsideEvent);
  },
};
</script>