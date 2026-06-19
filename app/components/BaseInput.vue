<template>
  <div class="space-y-1.5 w-full">
    <div class="flex justify-between items-center px-1">
      <label v-if="label" class="font-label text-xs font-medium text-on-surface-variant ml-1">
        {{ label }}
      </label>
      <slot name="label-right"></slot>
    </div>
    
    <div class="relative flex items-center">
      <input
        :value="modelValue"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @blur="$emit('blur')" 
        :type="isPasswordType && showPassword ? 'text' : type"
        :placeholder="placeholder"
        class="w-full bg-surface-container border border-outline-variant/30 rounded-xl pl-4 py-3.5 text-on-surface placeholder:text-zinc-600 focus:outline-none focus:shadow-[0_0_8px_rgba(0,218,243,0.4)] focus:border-[#00daf3] transition-all duration-300 border-input-custom disabled:opacity-50 disabled:cursor-not-allowed"
        :class="isPasswordType ? 'pr-12' : 'pr-4'"
        v-bind="$attrs"
      />
      
      <button
        v-if="isPasswordType"
        type="button"
        @click="showPassword = !showPassword"
        class="absolute right-0 flex items-center justify-center pr-4 text-on-surface-variant hover:text-[#00daf3] transition-colors focus:outline-none"
        tabindex="-1"
      >
        <span class="material-symbols-outlined text-[20px]">
          {{ showPassword ? 'visibility_off' : 'visibility' }}
        </span>
      </button>
    </div>
    
    <p v-if="error" class="text-error text-[10px] font-label mt-1 ml-1 leading-tight text-red-500">
      {{ error }}
    </p>
    <slot name="help-text"></slot>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps({
  modelValue: String,
  label: String,
  placeholder: String,
  type: { type: String, default: 'text' },
  error: String
})

defineEmits(['update:modelValue', 'blur']) // Register blur event

const showPassword = ref(false)
const isPasswordType = computed(() => props.type === 'password')
</script>
<style scoped>  
.border-input-custom {
  border-color: rgba(255, 255, 255, 0.3);
}
</style>
