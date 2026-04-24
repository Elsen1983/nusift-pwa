export default defineEventHandler((event) => {
  // Megsemmisítjük a HTTP-Only sütit
  deleteCookie(event, 'auth_token', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax'
  });

  return { success: true, message: 'Secure Handshake terminated.' };
});