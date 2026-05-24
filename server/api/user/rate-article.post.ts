// // server/api/user/rate-article.post.ts
// import { prisma } from '../../utils/prisma';

// export default defineEventHandler(async (event) => {
//   // 1. Biztonsági ellenőrzés (Token validálás)
//   const token = getCookie(event, 'auth_token');
//   if (!token) {
//     throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
//   }

//   // 2. Kérés törzsének olvasása
//   const body = await readBody(event);
//   const { id, score } = body;

//   if (!id || score === undefined) {
//     throw createError({ statusCode: 400, statusMessage: 'Missing ID or Score' });
//   }

//   try {
//     // 3. Adatbázis művelet (pl. frissítés)
//     // Itt a te adatbázis sémád szerint frissítsd az értékelést
//     await prisma.article.update({
//       where: { id: Number(id) },
//       data: { score: score }
//     });

//     return { success: true };
//   } catch (error) {
//     console.error('Rating update failed:', error);
//     throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' });
//   }
// });