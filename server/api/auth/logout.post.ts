export default defineEventHandler((event) => {
  // 1. Delete the HTTP-Only Authentication Cookie
  deleteCookie(event, 'auth_token', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax'
  });

  // 2. Delete the Session Status Cookie
  deleteCookie(event, 'session_status', {
    httpOnly: false,
    path: '/',
    sameSite: 'lax'
  });

  // 3. Optionally, you can also perform server-side cleanup here (e.g., invalidate tokens in DB if you store them)

  // --- Optional: Send a Logout Confirmation Email ---
  return { success: true, message: 'Secure Handshake terminated.' };
});