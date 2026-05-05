<!-- emails/WelcomeEmail.vue -->
<script setup lang="ts">
// Props allow you to pass dynamic data from your backend API into the email
defineProps<{
  userEmail: string;
  loginUrl: string;
}>();
</script>

<template>
  <EHtml>
    <EHead />
    <EPreview>Welcome to NuSift - Your Sovereign AI Reader</EPreview>
    <EBody class="bg-[#131313] font-sans text-white">
      <EContainer class="mx-auto p-8 bg-[#1e1e1e] rounded-xl border border-[#00E5FF]/20 mt-10 max-w-md">
        
        <!-- Header -->
        <ESection class="text-center mb-6">
          <EText class="text-[#00E5FF] text-2xl font-bold uppercase tracking-widest font-mono">
            NuSift
          </EText>
        </ESection>

        <!-- Body Content -->
        <EText class="text-gray-300 text-base leading-relaxed mb-4">
          Hello <strong>{{ userEmail }}</strong>,
        </EText>
        <EText class="text-gray-300 text-base leading-relaxed mb-6">
          Your account has been successfully created via your linked provider. Because you used a secure provider, your email is already verified. You are ready to calibrate your intelligence agent.
        </EText>

        <!-- Call to Action -->
        <ESection class="text-center mb-6">
          <EButton 
            :href="loginUrl"
            class="bg-[#00E5FF] text-black px-6 py-3 rounded-lg font-bold tracking-widest uppercase text-sm"
          >
            Access Dashboard
          </EButton>
        </ESection>

        <!-- Footer -->
        <EText class="text-gray-500 text-xs text-center mt-8">
          Securing your digital sovereignty. <br />
          NuSift Inc, Bandon, Ireland
        </EText>
      </EContainer>
    </EBody>
  </EHtml>
</template>