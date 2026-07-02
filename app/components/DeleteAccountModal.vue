<template>
  <Transition name="fade">
    <div v-if="isOpen" class="fixed inset-0 z-[200] flex items-center justify-center px-4">
      <div class="absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-md"></div>

      <div class="relative w-full max-w-md rounded-3xl border border-error/20 bg-surface-container-high p-8 shadow-2xl animate-in fade-in zoom-in duration-300">
        <div class="flex flex-col items-center text-center">
          <div class="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-error/20 bg-error/10">
            <span class="material-symbols-outlined text-3xl text-error">warning</span>
          </div>

          <h3 class="mb-2 font-headline text-xl font-bold uppercase tracking-tight text-on-surface">
            {{ $t("deleteAccountModal.title") }}
          </h3>
          <p class="mb-3 font-body text-sm leading-relaxed text-on-surface-variant">
            {{ $t("deleteAccountModal.description") }}
          </p>
          <p class="mb-8 font-body text-xs leading-relaxed text-error">
            {{ $t("deleteAccountModal.warning") }}
          </p>

          <div class="grid w-full grid-cols-2 gap-4">
            <button
              class="rounded-xl border border-outline-variant/30 bg-surface-bright py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface transition-colors hover:brightness-110"
              :disabled="isDeleting"
              @click="$emit('close')"
            >
              {{ $t("deleteAccountModal.btn_cancel") }}
            </button>
            <button
              class="rounded-xl bg-error py-3 text-[10px] font-bold uppercase tracking-widest text-on-error transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isDeleting"
              @click="$emit('confirm')"
            >
              {{ isDeleting ? $t("deleteAccountModal.btn_deleting") : $t("deleteAccountModal.btn_confirm") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{
  isOpen: boolean;
  isDeleting?: boolean;
}>();

defineEmits(["close", "confirm"]);
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
