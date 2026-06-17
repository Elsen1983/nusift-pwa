import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useUnsavedStore = defineStore('unsaved', () => {
  const forms = ref<Record<string, boolean>>({});

  function registerForm(id: string) {
    if (!forms.value[id]) forms.value[id] = false;
  }

  function unregisterForm(id: string) {
    delete forms.value[id];
  }

  function setDirty(id: string, dirty: boolean) {
    if (forms.value.hasOwnProperty(id)) {
      forms.value[id] = dirty;
    } else {
      // ensure it's registered
      forms.value[id] = dirty;
    }
  }

  const anyDirty = computed(() => Object.values(forms.value).some(Boolean));

  return { forms, registerForm, unregisterForm, setDirty, anyDirty };
});
