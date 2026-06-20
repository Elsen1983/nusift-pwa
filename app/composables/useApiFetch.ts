// composables/useApiFetch.ts
import { useFetch, useCookie } from '#app';
import type { UseFetchOptions } from 'nuxt/app';

export function useApiFetch<T>(
  request: Parameters<typeof useFetch>[0],
  opts?: UseFetchOptions<T>
) {
  const tokenCookie = useCookie('auth_token');

  // We construct the options object and cast it to bypass Nuxt's strict NoInfer checks internally
  const options = {
    ...opts,
    onResponseError(context: any) {
      if (context.response.status === 401 || context.response.status === 404) {
        console.error('Sovereign Shield: Session invalid. Logging out...');
        
        tokenCookie.value = null;
        // session_status is now httpOnly — server handles clearing it
        
        if (import.meta.client) {
          window.location.href = '/auth';
        }
      }
      
      // Safely execute local component-level onResponseError logic
    if (opts?.onResponseError) {
      if (typeof opts.onResponseError === 'function') {
        // If it's a single function, call it directly
        opts.onResponseError(context);
      } else if (Array.isArray(opts.onResponseError)) {
        // If it's an array of functions, iterate and call each one
        opts.onResponseError.forEach(fn => {
          if (typeof fn === 'function') fn(context);
        });
      }
    }
    }
  };

  // We cast the arguments to 'any' here to stop the compiler from complaining about internal Nuxt generics.
  // The return type of this function will still correctly infer as AsyncData<T, ...> for your components.
  return useFetch<T>(request as any, options as any);
}