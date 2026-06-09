// api.ts
import { $fetch } from 'ofetch';

export const $api = $fetch.create({
  onResponseError({ response }) {
    if (response.status === 401 || response.status === 404) {
      console.error('Sovereign Shield Intercept: Unauthorized API access. Terminating session.');
      
      if (import.meta.client) {
        document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        document.cookie = "session_status=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        window.location.href = '/auth';
      }
    }

    // TYPE FIX: Strictly use _data for ofetch payloads
    const backendMessage = response._data?.message || response.statusText;
    
    if (backendMessage) {
      response._data = {
        ...response._data,
        normalizedMessage: backendMessage
      };
    }
  }
});