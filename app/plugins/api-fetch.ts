export default defineNuxtPlugin((nuxtApp) => {
  const customFetch = $fetch.create({
    onResponseError({ response }) {
      // If ANY endpoint throughout the app returns a 401, the user's session is dead.
      if (response.status === 401) {
        console.error('Sovereign Shield Intercept: Unauthorized API access. Terminating session.');
        
        // Clear local cookies directly
        const tokenCookie = useCookie('auth_token');
        const sessionStatus = useCookie('session_status');
        tokenCookie.value = null;
        sessionStatus.value = null;
        
        // Force a hard redirect to the auth page
        if (process.client) {
          window.location.href = '/auth'; 
        }
      }
    }
  });

  return {
    provide: {
      api: customFetch
    }
  };
});