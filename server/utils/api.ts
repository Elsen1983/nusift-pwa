import { $fetch } from 'ofetch';

export const $api = $fetch.create({
  onResponseError({ response }) {
    if (response.status === 401 || response.status === 404) {
      console.error('Sovereign Shield Intercept: Unauthorized API access. Terminating session.');
      
      if (import.meta.client) {
        // Lejárt jövőbeli dátummal töröljük a sütiket a dokumentumból
        document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        document.cookie = "session_status=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        
        // Kényszerített kemény átirányítás az auth oldalra
        window.location.href = '/auth';
      }
    }
  }
});