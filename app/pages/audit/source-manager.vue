<template>
  <div class="bg-surface text-on-surface font-body min-h-screen overflow-x-hidden relative selection:bg-neon-cyan/30 selection:text-white">
    
    <div class="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-neon-cyan/5 rounded-full blur-[120px] pointer-events-none z-0"></div>
    <div class="fixed bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-secondary-container/10 rounded-full blur-[140px] pointer-events-none z-0"></div>
    
    <header class="fixed top-0 left-0 w-full z-50 bg-[#131313]/90 backdrop-blur-md border-b border-outline-variant/20">
      <div class="mx-auto w-full max-w-4xl flex items-center px-6 py-4">
        <button @click="router.back()" class="flex items-center gap-3 cursor-pointer group bg-transparent border-none p-0">
          <span class="material-symbols-outlined text-neon-cyan group-hover:-translate-x-1 transition-transform">arrow_back</span>
          <h1 class="font-headline tracking-tight text-lg font-semibold text-on-surface">Source Network</h1>
        </button>
      </div>
    </header>

    <main class="relative z-10 pt-28 pb-32 px-6 max-w-4xl mx-auto space-y-12">
      
      <section class="space-y-4">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h2 class="font-headline text-lg font-semibold tracking-tight text-on-surface flex items-center gap-2">
            Active Nodes: {{ quota.activeCount }}/{{ quota.limit }}
            <span class="text-on-surface-variant text-sm font-normal">({{ quota.tier === 'PRO' ? 'Pro' : 'Free' }} Tier)</span>
          </h2>
          
          <button v-if="quota.tier === 'FREE'" class="bg-surface-container-high hover:bg-surface-container-highest transition-colors px-4 py-2 rounded-full flex items-center gap-2 group outline outline-1 outline-outline-variant/30">
            <span class="font-label text-sm text-neon-cyan group-hover:drop-shadow-[0_0_8px_rgba(0,229,255,0.8)] transition-all">Upgrade to Pro (15 max)</span>
            <span class="material-symbols-outlined text-neon-cyan text-sm">rocket_launch</span>
          </button>
        </div>
        
        <div class="h-2 w-full bg-surface-container-low rounded-full overflow-hidden">
          <div 
            class="h-full bg-gradient-to-r from-neon-cyan to-[#9cf0ff] rounded-full relative transition-all duration-500"
            :style="{ width: `${progressPercentage}%` }"
          >
            <div class="absolute inset-0 bg-white/20 animate-pulse"></div>
          </div>
        </div>
      </section>

      <section class="bg-surface-container rounded-2xl p-6 shadow-[0_0_24px_0_rgba(0,229,255,0.08)] outline outline-1 outline-outline-variant/15 relative overflow-hidden">
        <div class="absolute top-0 right-0 w-32 h-32 bg-neon-cyan/5 rounded-full blur-[40px] -mt-10 -mr-10"></div>
        <h3 class="font-headline text-xl font-medium mb-4 text-on-surface relative z-10">Ingestion Hub</h3>
        
        <div class="flex flex-col md:flex-row gap-4 relative z-10">
          <div class="flex-grow relative group">
            <div class="absolute inset-y-0 left-4 flex items-center pointer-events-none">
              <span class="material-symbols-outlined text-on-surface-variant text-sm">link</span>
            </div>
            <input 
              v-model="newSourceUrl"
              @keyup.enter="addNewSource"
              class="w-full bg-surface-container-highest border-none rounded-xl py-4 pl-12 pr-4 text-on-surface placeholder:text-on-surface-variant/50 focus:ring-2 focus:ring-neon-cyan/50 focus:bg-surface-container-high transition-all font-body text-sm outline-none" 
              placeholder="Enter source URL (e.g. bloomberg.com/tech)..." 
              type="text"
              :disabled="isProcessing"
            />
          </div>
          <button 
            @click="addNewSource"
            :disabled="!newSourceUrl || isProcessing"
            class="bg-gradient-to-tr from-[#c3f5ff] to-neon-cyan text-[#131313] font-headline font-semibold py-4 px-8 rounded-xl hover:opacity-90 transition-opacity whitespace-nowrap flex items-center justify-center gap-2 shadow-[0_4px_20px_rgba(0,229,255,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span class="material-symbols-outlined text-sm" v-if="!isProcessing">add</span> 
            <span class="material-symbols-outlined text-sm animate-spin" v-else>sync</span> 
            Add Source
          </button>
        </div>
        
        <Transition name="fade">
          <div v-if="toast.show" :class="[
            'mt-4 flex items-center gap-2 text-sm font-label px-4 py-2 rounded-lg inline-flex outline outline-1 transition-all',
            toast.type === 'warning' ? 'text-tertiary-fixed bg-tertiary-fixed/10 outline-tertiary-fixed/20' : 
            toast.type === 'error' ? 'text-error bg-error/10 outline-error/20' : 
            'text-neon-cyan bg-neon-cyan/10 outline-neon-cyan/20'
          ]">
            <span class="material-symbols-outlined text-sm">
              {{ toast.type === 'warning' ? 'info' : toast.type === 'error' ? 'error' : 'check_circle' }}
            </span>
            {{ toast.message }}
          </div>
        </Transition>
      </section>

      <section class="space-y-6">
        <h3 class="font-headline text-xl font-medium text-on-surface flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-neon-cyan animate-pulse"></span>
          Active Data Streams
        </h3>
        
        <div class="grid grid-cols-1 gap-4" v-if="activeSources.length > 0">
          <div v-for="source in activeSources" :key="source.id" class="bg-surface-container-low hover:bg-surface-container transition-colors rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 outline outline-1 outline-outline-variant/15 group">
            
            <div class="flex-grow space-y-1">
              <h4 class="font-body font-bold text-on-surface text-lg">{{ getDomain(source.url) }}</h4>
              <p class="font-label text-xs text-on-surface-variant flex items-center gap-2" v-if="getPath(source.url)">
                {{ getPath(source.url) }}
              </p>
              
              <div class="flex gap-2 mt-3">
                <span v-for="(badge, index) in getBadges(source.validationStatus)" :key="index" :class="['inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1', badge.classes]">
                  <span class="material-symbols-outlined text-[12px]" :class="badge.iconClasses">{{ badge.icon }}</span> 
                  {{ badge.label }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button @click="toggleSourceState(source.id, false)" :disabled="isProcessing" class="p-2 text-on-surface-variant hover:text-on-surface bg-surface-container-highest rounded-full transition-colors flex items-center justify-center outline outline-1 outline-transparent hover:outline-outline-variant/30 disabled:opacity-50" title="Suspend Stream">
                <span class="material-symbols-outlined text-sm" style="font-variation-settings: 'FILL' 1;">pause</span>
              </button>
              <button @click="deleteSource(source.id)" :disabled="isProcessing" class="p-2 text-error/70 hover:text-error hover:bg-error/10 rounded-full transition-colors flex items-center justify-center disabled:opacity-50" title="Delete Source">
                <span class="material-symbols-outlined text-sm">delete</span>
              </button>
            </div>

          </div>
        </div>
        <div v-else class="text-center py-8 text-on-surface-variant font-body">
          No active data streams. Add a source above to begin routing data.
        </div>
      </section>

      <section class="space-y-6 opacity-80 hover:opacity-100 transition-opacity">
        <h3 class="font-headline text-xl font-medium text-on-surface-variant flex items-center gap-2">
          <span class="material-symbols-outlined text-xl">inventory_2</span>
          Suspended Zone
        </h3>
        
        <div class="grid grid-cols-1 gap-4" v-if="suspendedSources.length > 0">
          <div v-for="source in suspendedSources" :key="source.id" class="bg-surface-container-lowest rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 outline outline-1 outline-outline-variant/20 border-l-2 border-l-outline-variant">
            
            <div class="flex-grow space-y-1 opacity-60 grayscale group-hover:grayscale-0 transition-all">
              <h4 class="font-body font-bold text-on-surface-variant text-lg">{{ getDomain(source.url) }}</h4>
              <p class="font-label text-xs text-outline flex items-center gap-2" v-if="getPath(source.url)">
                {{ getPath(source.url) }}
              </p>
              <div class="flex gap-2 mt-3">
                <span v-for="(badge, index) in getBadges(source.validationStatus)" :key="index" :class="['inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-label outline outline-1', badge.classes]">
                  <span class="material-symbols-outlined text-[12px]" :class="badge.iconClasses">{{ badge.icon }}</span> 
                  {{ badge.label }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2 relative group">
              <div v-if="isQuotaFull" class="absolute bottom-full right-0 mb-2 w-max bg-surface-bright text-on-surface text-[10px] font-label px-3 py-2 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                Suspend an active source to free up space.
              </div>
              
              <button 
                @click="toggleSourceState(source.id, true)"
                :disabled="isQuotaFull || isProcessing"
                class="p-2 text-on-surface-variant bg-surface-container-low rounded-full flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-neon-cyan/20 hover:text-neon-cyan"
              >
                <span class="material-symbols-outlined text-sm" style="font-variation-settings: 'FILL' 1;">play_arrow</span>
              </button>
              
              <button @click="deleteSource(source.id)" :disabled="isProcessing" class="p-2 text-error/50 hover:text-error hover:bg-error/10 rounded-full transition-colors flex items-center justify-center z-10 relative cursor-pointer disabled:opacity-30">
                <span class="material-symbols-outlined text-sm">delete</span>
              </button>
            </div>

          </div>
        </div>
        <div v-else class="text-center py-4 text-outline font-body text-sm">
          Your suspended zone is empty.
        </div>
      </section>

    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

// --- STATE ---
const newSourceUrl = ref('');
const isProcessing = ref(false);
const toast = ref({ show: false, message: '', type: 'success' });

// Expected data structure from the `/api/user/sources` endpoint
const sources = ref<any[]>([]);
const quota = ref({
  tier: 'FREE',
  limit: 5,
  activeCount: 0,
  availableSlots: 5
});

// --- COMPUTED ---
const activeSources = computed(() => sources.value.filter(s => s.isActive));
const suspendedSources = computed(() => sources.value.filter(s => !s.isActive));
const isQuotaFull = computed(() => quota.value.activeCount >= quota.value.limit);
const progressPercentage = computed(() => (quota.value.activeCount / quota.value.limit) * 100);

// --- METHODS ---

onMounted(async () => {
  await fetchSourceData();
});

const fetchSourceData = async () => {
  try {
    const response = await $fetch('/api/user/sources');
    if(response.success) {
      sources.value = response.sources;
      quota.value = response.quota;
    }
  } catch (error) {
    console.error("Failed to load sources", error);
    showToast('Failed to load data. Please refresh.', 'error');
  }
};

const addNewSource = async () => {
  if (!newSourceUrl.value || isProcessing.value) return;
  isProcessing.value = true;
  
  try {
    const response: any = await $fetch('/api/user/sources/add', {
      method: 'POST',
      body: { url: newSourceUrl.value }
    });
    
    if (response.success) {
      if (response.activated) {
        showToast(response.message, 'success');
      } else {
        showToast(response.message, 'warning');
      }
      
      newSourceUrl.value = '';
      await fetchSourceData(); // Refresh list to get accurate DB state
    }
  } catch (error: any) {
    console.error(error);
    showToast(error.data?.statusMessage || 'Failed to add source', 'error');
  } finally {
    isProcessing.value = false;
  }
};

const toggleSourceState = async (id: string, activate: boolean) => {
  if (activate && isQuotaFull.value) return;
  
  isProcessing.value = true;
  try {
    const response: any = await $fetch('/api/user/sources/toggle', {
      method: 'PUT',
      body: { sourceId: id, isActive: activate }
    });
    
    if (response.success) {
      await fetchSourceData(); // Sync exact quota and lists
    }
  } catch (error: any) {
    console.error("Failed to toggle state", error);
    showToast(error.data?.statusMessage || 'Failed to toggle source state', 'error');
  } finally {
    isProcessing.value = false;
  }
};

const deleteSource = async (id: string) => {
  isProcessing.value = true;
  try {
    const response: any = await $fetch(`/api/user/sources/${id}`, { 
      method: 'DELETE' 
    });
    
    if (response.success) {
      await fetchSourceData(); // Sync exact quota and lists
    }
  } catch (error: any) {
    console.error("Failed to delete source", error);
    showToast(error.data?.statusMessage || 'Failed to delete source', 'error');
  } finally {
    isProcessing.value = false;
  }
};

// --- UTILS ---

const showToast = (message: string, type: 'success' | 'warning' | 'error') => {
  toast.value = { show: true, message, type };
  setTimeout(() => { toast.value.show = false; }, 4000);
};

// Helper to format URLs for the UI
const getDomain = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } 
  catch { return url; }
};

const getPath = (url: string) => {
  try {
    const path = new URL(url).pathname;
    return path === '/' ? '' : path.substring(1).replace(/\//g, ' > ');
  } catch { return ''; }
};

// Translates Prisma DB states into UI Badges
const getBadges = (status: string) => {
  const badges = [];

  switch(status) {
    case 'ACTIVE':
      badges.push({ label: 'Verified', icon: 'verified_user', classes: 'bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]', iconClasses: '' });
      badges.push({ label: 'RSS Found', icon: 'rss_feed', classes: 'bg-[#00363d]/40 text-neon-cyan outline-[#00363d]', iconClasses: '' });
      break;
    case 'PENDING_DISCOVERY':
      badges.push({ label: 'Pending Sync', icon: 'hourglass_empty', classes: 'bg-[#3a3002]/40 text-tertiary-fixed outline-[#3a3002]', iconClasses: 'animate-spin-slow' });
      break;
    case 'NO_RSS_FOUND':
      badges.push({ label: 'Verified', icon: 'verified_user', classes: 'bg-[#194d56]/40 text-[#b9ebf5] outline-[#194d56]', iconClasses: '' });
      badges.push({ label: 'Direct Crawl', icon: 'public', classes: 'bg-surface-variant/50 text-on-surface-variant outline-outline-variant', iconClasses: '' });
      break;
    case 'FAILED':
    case 'DOMAIN_DEAD':
      badges.push({ label: 'Connection Error', icon: 'error', classes: 'bg-error/20 text-error outline-error/40', iconClasses: '' });
      break;
  }
  return badges;
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
.animate-spin-slow {
  animation: spin 3s linear infinite;
}
</style>