<template>
  <div class="relative w-full">
    <button @click="toggle" type="button" class="w-full flex items-center gap-3 p-2 rounded-md hover:bg-surface-container-highest transition-colors">
      <img :src="currentValue" class="w-10 h-10 rounded-full object-cover bg-surface-container-highest" alt="avatar"/>
      <div class="flex-1 text-left">
        <div class="text-sm font-medium">{{ label }}</div>
        <div class="text-xs text-on-surface-variant">{{ subtitle }}</div>
      </div>
      <span class="material-symbols-outlined">expand_more</span>
    </button>

    <div
      v-show="open"
      class="absolute left-0 right-0 mt-2 bg-surface-container-low rounded-2xl border border-outline-variant/10 shadow-lg p-4 z-50"
    >
      <div class="max-h-[420px] overflow-y-auto pr-1 hide-scrollbar">
        <div class="grid grid-cols-5 gap-3">
        <button
          v-for="(a, idx) in avatars"
          :key="idx"
          @click="selectAvatar(a)"
          type="button"
          class="w-full p-1 rounded-lg hover:scale-105 transition-transform focus:outline-none"
          >
            <img :src="a" class="w-full h-16 object-cover rounded-full" :alt="`avatar-${idx+1}`" />
          </button>
        </div>
      </div>
      <div class="mt-3 text-right">
        <button @click="close" type="button" class="px-3 py-1 text-sm rounded-md bg-surface-variant hover:bg-surface-container-highest">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import defaultAvatar from '~/assets/images/default_avatar.png';

const props = defineProps<{ modelValue?: string, label?: string, subtitle?: string }>();
const emits = defineEmits(['update:modelValue','select']);

const open = ref(false);
const toggle = () => (open.value = !open.value);
const close = () => (open.value = false);

// Load avatars from the assets folder. Eager to get urls at build time.
const modules = import.meta.glob('/assets/images/avatars/*.{png,jpg,jpeg,webp,svg}', { eager: true, as: 'url' });
const avatars = Object.values(modules) as string[];

const currentValue = computed(() => props.modelValue || defaultAvatar);
const label = computed(() => props.label || 'Choose avatar');
const subtitle = computed(() => props.subtitle || 'Select from predefined avatars');

watch(open, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  const active = document.activeElement as HTMLElement | null;
  active?.blur?.();
});

function selectAvatar(url: string) {
  emits('update:modelValue', url);
  emits('select', url);
  close();
}
</script>

<style scoped>
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24}
.hide-scrollbar::-webkit-scrollbar{display:none}
.hide-scrollbar{-ms-overflow-style:none;scrollbar-width:none}
</style>
