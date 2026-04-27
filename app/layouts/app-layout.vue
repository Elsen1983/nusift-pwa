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
        <div class="flex items-center gap-4">
          <div class="w-9 h-9 rounded-full overflow-hidden" style="border: 2px solid #00E5FF;">
            <img alt="User Profile" class="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuCKQFpho9N6vNb597g658gofpMtTfArkL752rpR3k6rxeDzEqXZerZhpd3mQs7bV1aSAfXs4c8OjyoaWQaiNXQjAldOB7gFixiZbOkrydVdRRwix4N1uCOiik3IkWYLzb921cnm_F4R4A3LFfa-8Ah5YAzjox-xAfSPbCwz7wtURyhhHFZseEljkd2aDX_o91u5QK2zrT0nD981j4OgFsCrBPN4tsTfJkGVoNL_xnc0-f81gL5h9OEKzGG9XnOID8ANo2j1kJbhz8k"/>
          </div>
        </div>
      </header>
    </div>

    <div class="pt-[60px] pb-28">
      <slot />
    </div>

    <nav class="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-5 pt-2 bg-[#1c1b1b]/80 backdrop-blur-xl shadow-[0_-4px_24px_rgba(0,229,255,0.08)] rounded-t-[28px]">
      <NuxtLink to="/dashboard" class="flex flex-col items-center justify-center text-[#c3f5ff] bg-[#353534]/50 rounded-xl px-3 py-1.5 transition-all duration-300">
        <span class="material-symbols-outlined text-xl" :style="{ fontVariationSettings: '\'FILL\' 1' }">newspaper</span>
        <span class="font-label text-[10px] font-medium mt-0.5">News</span>
      </NuxtLink>
      <NuxtLink to="/saved" class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 hover:text-[#00e5ff] transition-all">
        <span class="material-symbols-outlined text-xl">bookmarks</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Saved</span>
      </NuxtLink>
      <NuxtLink to="/shared" class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 hover:text-[#00e5ff] transition-all">
        <span class="material-symbols-outlined text-xl">share</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Shared</span>
      </NuxtLink>
      <NuxtLink to="/trends" class="flex flex-col items-center justify-center text-[#bac9cc] py-1.5 hover:text-[#00e5ff] transition-all">
        <span class="material-symbols-outlined text-xl">trending_up</span>
        <span class="font-label text-[10px] font-medium mt-0.5">Trends</span>
      </NuxtLink>
    </nav>
  </div>
</template>