// server/api/util/check-source.post.ts
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const rawUrl = body.url;

  if (!rawUrl) {
    throw createError({ statusCode: 400, statusMessage: "URL is required" });
  }

  try {
    // URL tisztítás
    let targetUrl = rawUrl.trim();
    if (!targetUrl.startsWith('http')) targetUrl = `https://${targetUrl}`;

    // Hálózati validáció (HEAD kérés)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(targetUrl, { 
      method: 'HEAD', 
      signal: controller.signal 
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw createError({ statusCode: 404, statusMessage: "URL nem érhető el" });
    }

    // A végleges, átirányított kanonikus URL
    const finalUrl = response.url; 
    const urlObj = new URL(finalUrl);
    const cleanHostname = urlObj.hostname.replace(/^www\./, '');

    // Adatbázis keresés a domainre
    const existingSource = await prisma.newsSource.findFirst({
      where: { frontPageUrl: { contains: cleanHostname, mode: 'insensitive' } }
    });

    return {
      success: true,
      url: finalUrl, // Itt már a tiszta, végleges link van!
      name: existingSource?.mediaName || cleanHostname,
      status: existingSource?.rssStatus || 'PENDING_DISCOVERY'
    };

  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw createError({ statusCode: 408, statusMessage: "Időtúllépés" });
    }
    throw createError({ statusCode: 400, statusMessage: "Érvénytelen vagy nem elérhető URL" });
  }
});