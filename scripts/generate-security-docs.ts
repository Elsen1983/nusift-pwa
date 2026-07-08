import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
} from 'docx';
import fs from 'fs';
import path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1): Paragraph {
  return new Paragraph({ heading: level, spacing: { after: 120, before: 200 } });
}

function p(text: string, opts?: { bold?: boolean; italic?: boolean; color?: string; size?: number }): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({
        text,
        bold: opts?.bold,
        italics: opts?.italic,
        color: opts?.color,
        size: opts?.size,
      }),
    ],
  });
}

function richP(runs: TextRun[]): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: runs });
}

function codeBlock(text: string): Paragraph[] {
  const lines = text.split('\n');
  const result: Paragraph[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(
      new Paragraph({
        spacing: { after: 0, line: 276 },
        shading: { type: ShadingType.SOLID, color: 'F5F5F5' },
        children: [
          new TextRun({
            text: lines[i] || ' ',
            font: 'Consolas',
            size: 18,
            color: '333333',
          }),
        ],
      }),
    );
  }
  // Add empty paragraph after code block for spacing
  result.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  return result;
}

function bullet(text: string, level = 0): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    bullet: { level },
    children: [new TextRun({ text, size: 22 })],
  });
}

function emptyLine(): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: [] });
}

function hr(): Paragraph {
  return new Paragraph({
    spacing: { after: 100 },
    border: { bottom: { color: 'CCCCCC', size: 6, style: BorderStyle.SINGLE } },
    children: [],
  });
}

// Colored badge text for severity
function severityBadge(severity: 'KRITIKUS' | 'MAGAS' | 'KÖZEPES' | 'ALACSONY'): TextRun {
  const colors: Record<string, string> = {
    KRITIKUS: 'DC2626',
    MAGAS: 'EA580C',
    KÖZEPES: 'CA8A04',
    ALACSONY: '16A34A',
  };
  return new TextRun({
    text: ` ${severity} `,
    bold: true,
    color: 'FFFFFF',
    size: 20,
    shading: { type: ShadingType.SOLID, color: colors[severity] },
  });
}

// ── Document 1: Security Audit Report ────────────────────────────────

function buildAuditReport(): Document {
  const children: Array<Paragraph | Table> = [];

  // Title
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: 'NuSift Biztonsági Audit Jelentés', bold: true, size: 36, color: '1a1a1a' }),
      ],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({ text: 'Sebezhetőségi elemzés kategorizálva a súlyosság és javítási sürgősség szerint', italics: true, size: 24, color: '666666' }),
      ],
    }),
  );

  // Summary section
  children.push(heading('Összegzés', HeadingLevel.HEADING_1));
  children.push(
    p('A projekt biztonsági architektúrája alapvetően jó alapokon nyugszik: JWT tokenek, httpOnly cookie-k, SSRF védelem, CSRF guard, rate limiting, HTML sanitization, és bcrypt jelszó-hashing. Ugyanakkor több területen azonosítottam külső támadásokkal szembeni sebezhetőségeket.'),
  );
  children.push(emptyLine());

  // ── CRITICAL ──
  children.push(heading('Kritikus sürgősségű sebezhetőségek', HeadingLevel.HEADING_1));

  // #1
  children.push(richP([
    new TextRun({ text: '#1  Dev végpontok nem admin-jogosultság-ellenőrzöttek', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KRITIKUS'), new TextRun({ text: '  (ha élesben engedélyezve van)', size: 22 })]));
  children.push(p('Érintett fájlok: server/api/dev/*.post.ts, server/api/dev/*.get.ts'));
  children.push(p('Probléma: A dev végpontok (pl. agent-logs.delete.ts ami törli az összes cikket és szkennelési naplót) csak requireUserId-t használnak – bármelyik bejelentkezett felhasználó hozzáfér. A production guard (NODE_ENV === "production" && NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") csak akkor blokkol, ha a környezeti változó nincs true-ra állítva. Ha valaki véletlenül bekapcsolja ezt a flag-et, bármelyik user végrehajthat pusztító műveleteket.'));
  children.push(...codeBlock(`// server/api/dev/agent-logs.delete.ts
requireUserId(event); // Csak bejelentkezett user kell
// NINCS admin szerepkör ellenőrzés!
if (process.env.NODE_ENV === "production" &&
    process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
  throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
}
// Törli az ÖSSZES cikket és naplót!
await prisma.$transaction([
  prisma.article.deleteMany({}),       // ⚠️ Minden cikk
  prisma.agentScanLog.deleteMany({}),  // ⚠️ Minden napló
  ...
]);`));
  children.push(p('Támadási forgatókönyv: Ha NUXT_ALLOW_MANUAL_NOTIFICATION_RUN=true van beállítva, bármelyik egyszerű free-tier felhasználó meghívja a DELETE /api/dev/agent-logs végpontot és törli a teljes cikk-adatbázist.'));
  children.push(p('Javítás: Admin szerepkör bevezetése a User sémában, és kötelező admin ellenőrzés a dev végpontokon.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #2
  children.push(richP([
    new TextRun({ text: '#2  Seed végpont – timing attack a titkos kulcs összehasonlításán', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KRITIKUS')]));
  children.push(p('Érintett fájl: server/api/util/seed-region.post.ts'));
  children.push(p('Probléma: Az admin titkos kulcsot egyszerű !== operátorral hasonlítja össze, ami timing attack-et tesz lehetővé. Ezen felül a végpont fájlokat ír a data/sources/ mappába, így visszaélése fájlrendszer manipulációt okozhat.'));
  children.push(...codeBlock(`const providedSecret = getRequestHeader(event, 'x-seed-secret');
if (!providedSecret || providedSecret !== expectedSecret) {
  // ⚠️ Simple comparison: vulnerable to timing attacks
  throw createError({ statusCode: 403, message: 'Forbidden.' });
}`));
  children.push(p('Támadási forgatókönyv: Egy támadó megméri a válaszidőt a titkos kulcs karakterenkénti kitalálásához, majd admin hozzáférést szerez a seed végponthoz, ami overwrite-olhatja a forrásadatbázist.'));
  children.push(p('Javítás: Használjon crypto.timingSafeEqual()-t konstans idejű összehasonlításhoz.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // ── HIGH ──
  children.push(heading('Magas sürgősségű sebezhetőségek', HeadingLevel.HEADING_1));

  // #3
  children.push(richP([
    new TextRun({ text: '#3  OAuth token hiányos validáció', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('MAGAS')]));
  children.push(p('Érintett fájl: server/api/auth/oauth.post.ts'));
  children.push(p('Probléma: A Google OAuth token validációja nem ellenőrzi a token audience (közönség) claim-jét, csak a Google userinfo végponthoz küldi a Bearer tokent. A token eredetét (client ID-t) nem validálja, így elméletileg egy másik alkalmazásból származó Google token is felhasználható fiók-átvételre.'));
  children.push(...codeBlock(`const googleResponse: any = await $fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
  headers: { Authorization: \`Bearer \${token}\` }
});
// ⚠️ Nincs audience/client_id ellenőrzés
if (!googleResponse?.email) throw new Error("Invalid Google Token");
verifiedEmail = googleResponse.email;`));
  children.push(p('Támadási forgatókönyv: Ha egy támadó rendelkezik egy érvényes Google token-nel egy másik alkalmazásból (más client ID-val), ezt használhatja NuSift fiók létrehozására vagy meglévő fiókba való bejelentkezésre, ha az email cím egyezik.'));
  children.push(p('Javítás: A token dekódolása és az aud claim ellenőrzése a saját Google client ID ellen.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #4
  children.push(richP([
    new TextRun({ text: '#4  A profil frissítők nem szanitizálják a bevitelt (XSS kockázat)', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('MAGAS')]));
  children.push(p('Érintett fájlok: server/api/user/profile/identity.put.ts, server/api/user/profile/billing.put.ts'));
  children.push(p('Probléma: A szerveroldali profil frissítők nem végeznek szerveroldali validálást vagy sanitizálást a bejövő adatokon. A nickname mező publikus (barátok keresésekor megjelenik), így ha megjelenítik v-html vagy más felületen XSS-hez vezethet. Az aboutMyself 1000 karakterra van vágva, de nincs szanitizálva.'));
  children.push(...codeBlock(`// identity.put.ts
if (nickname !== undefined) profileUpdate.nickname = nickname || null;
// ⚠️ Nincs HTML sanitizálás vagy regex validáció
if (aboutMyself !== undefined) {
  profileUpdate.aboutMyself = aboutMyself ? String(aboutMyself).slice(0, 1000) : null;
  // Csak hossz vágás, nincs tartalmi szanitizálás
}`));
  children.push(p('Támadási forgatókönyv: Egy támadó regisztrál egy fiókot és beállítja a nickname-ét "<img src=x onerror=alert(document.cookie)>" értékre. Ha a frontend ezt v-html-vel vagy más módon megjeleníti, XSS támadás valósul meg más felhasználók böngészőiben.'));
  children.push(p('Javítás: Szerveroldali bemenet-validálás és sanitizálás bevezetése.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #5
  children.push(richP([
    new TextRun({ text: '#5  RSS hírfeldolgozás külső URL-ek követése (SSRF maradék kockázat)', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('MAGAS')]));
  children.push(p('Érintett fájl: server/utils/news-pipeline/ingest.ts'));
  children.push(p('Probléma: A safeFetch jól védi az első kérést, de a HTML-fallback logika最多 8 linkre indít külön HTTP kérést. Egy rosszindulatú RSS feed (amit egy user hozzáadhat) tetszőleges URL-eket tartalmazhat, amiket a rendszer megkísérel letölteni, ami DDoS-szerű viselkedést okozhat.'));
  children.push(...codeBlock(`const links = linkMatches.map(...).filter(...).slice(0, 8);
// Minden linkre külön HTTP kérés történik
for (const link of links) {
  const detailResponse = await safeFetch(link, {...}).catch(() => null);
  // ⚠️ Egy rosszindulatú forrás 8 kérést eredményezhet`));
  children.push(p('Támadási forgatókönyv: Egy támadó hozzáad egy rosszindulatú hírforrást, amelynek RSS feed-je tetszőleges URL-eket tartalmaz. Ezeket a rendszer megpróbálja letölteni, ami DDoS-szerű viselkedést okozhat.'));
  children.push(p('Javítás: A HTML-fallback kéréseket sebességkorlátozásnak kell alávetni, és a linkek száma csökkentendő.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // ── MEDIUM ──
  children.push(heading('Közepes sürgősségű sebezhetőségek', HeadingLevel.HEADING_1));

  // #6
  children.push(richP([
    new TextRun({ text: '#6  A jelszó-komplexitás nincs mindenhol érvényesítve', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KÖZEPES')]));
  children.push(p('Érintett fájl: server/api/auth/oauth.post.ts'));
  children.push(p('Probléma: Az OAuth-regisztrált felhasználók soha nem kapnak jelszót. Ha egy OAuth-felhasználó később jelszavas bejelentkezést próbál, az "Invalid credentials" üzenetet kap, ami informatívan elárulja, hogy az email cím regisztrálva van (fiók enumeráció).'));
  children.push(emptyLine());
  children.push(hr());

  // #7
  children.push(richP([
    new TextRun({ text: '#7  A GET végpontok nem igényelnek autentikációt', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KÖZEPES')]));
  children.push(p('Érintett fájlok: server/api/util/get-regional-sources.ts, server/api/util/get-regional-whitelist.ts, server/api/util/get-location.ts'));
  children.push(p('Probléma: Ezek a végpontok publikusan elérhetők, külső API kulcsokat használnak és adatokat szolgáltatnak. Nem rendelkeznek rate limiting-gel sem autentikációval, így egy támadó exponenciálisan sok kéréssel elfogyaszthatja a harmadik féltől származó API krediteket (API költség-támadás).'));
  children.push(...codeBlock(`// get-regional-sources.ts – NINCS requireUserId, NINCS assertRateLimit
export default defineCachedEventHandler(async (event) => {
  const apiKey = process.env.NEWSDATA_API_KEY;
  // ⚠️ Bárki hívhatja, költséget generál
  const response: any = await $fetch('https://newsdata.io/api/1/sources', {...});`));
  children.push(p('Támadási forgatókönyv: Egy támadó szkripttel ezerszer meghívja a GET /api/util/get-regional-sources?country=US végpontot, ami elfogyasztja a NewsData.io API krediteket és költséget okoz.'));
  children.push(p('Javítás: Rate limiting hozzáadása, és autentikáció követelése.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #8
  children.push(richP([
    new TextRun({ text: '#8  In-memory rate limiter nem működik megfelelően több instance esetén', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KÖZEPES')]));
  children.push(p('Érintett fájl: server/utils/rate-limit.ts'));
  children.push(p('Probléma: Ha az UPSTASH_REDIS_REST_URL nincs konfigurálva, a rate limiter in-memory fallback-re vált, ami csak egyetlen szerver instance esetén működik. Serverless deployment (pl. Vercel) esetén minden instance saját számlálóval rendelkezik, így a tényleges limit N × limit lesz.'));
  children.push(...codeBlock(`if (process.env.NODE_ENV === "production" && !productionWarned) {
  productionWarned = true;
  console.warn("[rate-limit] ⚠ No Upstash Redis configured...");
  // ⚠️ Csak warning, nem dob hibát
}`));
  children.push(p('Támadási forgatókönyv: Production-ben, Upstash Redis nélkül, a brute-force támadók (pl. jelszó-próbálgatás) N × 10 próbát tehetnek percenként (ahol N = instance száma).'));
  children.push(p('Javítás: Production-ben, ha nincs Upstash konfigurálva, a rate-limitet szigorúbbá kell tenni.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #9
  children.push(richP([
    new TextRun({ text: '#9  A push notification subscription IDOR sebezhetőség', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KÖZEPES')]));
  children.push(p('Érintett fájl: server/api/notifications/subscribe.post.ts'));
  children.push(p('Probléma: A subscribe.post.ts upsert-je endpoint alapján végez upsert-et, nem userId+endpoint kombináció alapján. Az update ág felülírja a userId-t.'));
  children.push(...codeBlock(`await prisma.pushSubscription.upsert({
  where: { endpoint: subscription.endpoint },
  update: { userId, ... }, // ⚠️ Felülírja a userId-t!
  create: { userId, endpoint: subscription.endpoint, ... },
});`));
  children.push(p('Támadási forgatókönyv: Ha egy támadó ismer egy másik felhasználó push endpoint URL-ét, és POST-ol a /api/notifications/subscribe végpontra a saját session-jével, akkor átírhatja a subscription tulajdonosát magára.'));
  children.push(p('Javítás: Az upsert update ágában ne frissítse a userId-t, és ellenőrizze a tulajdonost.', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // #10
  children.push(richP([
    new TextRun({ text: '#10  A CSRF védelem localhost origin megengedése production-ben', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('KÖZEPES')]));
  children.push(p('Érintett fájl: server/middleware/csrf-guard.ts'));
  children.push(p('Probléma: Ha a production appUrl tartalmazza a "localhost" string-et (misconfiguration), a CSRF guard engedélyezi a localhost eredetű kéréseket, ami lehetővé teszi a CSRF támadást.'));
  children.push(...codeBlock(`if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
  allowedOrigins.add("http://localhost:3000");  // ⚠️ Dev origin hozzáadva
  // Ha appUrl véletlenül localhost, ez production-ben is él
}`));
  children.push(p('Javítás: Az appUrl.includes("localhost") ellenőrzés csak dev módban történjen (NODE_ENV !== "production").', { bold: true }));
  children.push(emptyLine());
  children.push(hr());

  // ── LOW ──
  children.push(heading('Alacsony sürgősségű sebezhetőségek', HeadingLevel.HEADING_1));

  // #11
  children.push(richP([
    new TextRun({ text: '#11  A JWT iss/aud validáció lazított (backward-compat)', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('ALACSONY')]));
  children.push(p('Érintett fájl: server/utils/auth.ts'));
  children.push(p('Probléma: A verifySessionToken opcionálisan validálja az iss és aud claim-eket: csak akkor ellenőrzi, ha jelen vannak a token-ben. Régi tokenek iss/aud nélkül továbbra is érvényesek.'));
  children.push(p('Javítás: A validáció legyen szigorú (kötelező iss és aud).'));
  children.push(emptyLine());
  children.push(hr());

  // #12
  children.push(richP([
    new TextRun({ text: '#12  A verificationToken lejárati ellenőrzése átugorható', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('ALACSONY')]));
  children.push(p('Érintett fájl: server/api/auth/verify.post.ts'));
  children.push(p('Probléma: Ha verificationTokenExpires null (régi felhasználók), a lejárat nem kerül ellenőrzésre, így a token határozatlan ideig érvényes marad.'));
  children.push(...codeBlock(`if (user.verificationTokenExpires && user.verificationTokenExpires < new Date()) {
  // ⚠️ Ha null, átugorja – a token örökké él
  throw createError({ statusCode: 401, ... });
}`));
  children.push(p('Javítás: Átírás kötelező lejáratra: if (!user.verificationTokenExpires || user.verificationTokenExpires < new Date()).'));
  children.push(emptyLine());
  children.push(hr());

  // #13
  children.push(richP([
    new TextRun({ text: '#13  A GeoIP fallback HTTP-t használ', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('ALACSONY')]));
  children.push(p('Érintett fájl: server/api/util/get-location.ts'));
  children.push(p('Probléma: A GeoIP fallback szolgáltatás (ip-api.com) HTTP-t használ, ami nem titkosított kapcsolatot jelent. MITM támadásnak kitett, és a válasz meghamisítható.'));
  children.push(...codeBlock(`const fallbackResponse: any = await $fetch('http://ip-api.com/json/', {
  // ⚠️ HTTP, nem HTTPS
  timeout: 4000
});`));
  children.push(p('Javítás: Használjon HTTPS-t támogató szolgáltatást.'));
  children.push(emptyLine());
  children.push(hr());

  // #14
  children.push(richP([
    new TextRun({ text: '#14  Az api.ts kliensoldali cookie-törlés nem távolítja el a secure flag-et', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('ALACSONY')]));
  children.push(p('Érintett fájl: app/utils/api.ts'));
  children.push(p('Probléma: A kliensoldali logout cookie-törlés nem használ secure flag-et, ami production-ben (ahol a cookie secure-re van állítva) hatástalan lehet bizonyos böngészőkben.'));
  children.push(p('Javítás: A szerveroldali logout már helyesen törli a cookie-kat. A kliensoldali törlés felesleges és eltávolítható.'));
  children.push(emptyLine());
  children.push(hr());

  // #15
  children.push(richP([
    new TextRun({ text: '#15  A feed végpont nem paginál és nem korlátozza a találatok számát', bold: true, size: 26 }),
  ]));
  children.push(richP([severityBadge('ALACSONY')]));
  children.push(p('Érintett fájl: server/api/feed.ts'));
  children.push(p('Probléma: A /api/feed végpont az összes cikket visszaadja a feliratkozott forrásokból, limit nélkül.'));
  children.push(...codeBlock(`const articles = await prisma.article.findMany({
  where: {...},
  orderBy: [{ date: "desc" }, { id: "desc" }],
  // ⚠️ Nincs take/skip (pagination)
});`));
  children.push(p('Támadási forgatókönyv: Egy felhasználó sok forrásra feliratkozik, majd a feed végpont több ezer cikket tölt be, ami memória- és sávszélesség-terhelést okoz (DoS-közeli állapot).'));
  children.push(p('Javítás: take: 50 (vagy hasonló) limit hozzáadása, opcionálisan kurzor-alapú pagination.'));
  children.push(emptyLine());
  children.push(hr());

  // ── Good practices ──
  children.push(heading('Jól implementált biztonsági elemek', HeadingLevel.HEADING_1));
  children.push(p('A következő biztonsági gyakorlatok megfelelően vannak implementálva:'));
  const goodPractices = [
    'bcrypt jelszó-hashing (10-es salt rounds)',
    'JWT tokenek httpOnly, secure, SameSite=Lax cookie-kban',
    'tokenVersion-alapú session revocation (jelszó-visszaállításkor inkrementálódik)',
    'SSRF guard (DNS validáció, IP range check, redirect following)',
    'CSRF guard Origin/Referer alapú (a #10 kivételével)',
    'DOMPurify HTML sanitization kliensoldalon',
    'Szerveroldalon minden HTML tag eltávolítása',
    'Anti-enumeration forgot-password (azonos válasz minden esetben)',
    'Rate limiting auth végpontokon (Upstash hiányában gyenge)',
    'Security headers (CSP, X-Frame-Options, X-Content-Type-Options stb.)',
    'Push endpoint SSRF validáció',
    'Password complexity validation (12 karakter, kis/nagy/szám/speciális)',
    'OAuth account conflict detection',
    'Notification/notification deletion owner ellenőrzés',
    'Source subscription owner ellenőrzés toggle/delete',
  ];
  for (const practice of goodPractices) {
    children.push(bullet(`✅ ${practice}`));
  }
  children.push(emptyLine());
  children.push(hr());

  // ── Priority table ──
  children.push(heading('Javítási prioritási sorrend', HeadingLevel.HEADING_1));

  const priorityRows = [
    ['#1', 'Dev végpontok admin jogosultság nélkül', 'Kritikus', 'Közepes'],
    ['#2', 'Seed végpont timing attack', 'Kritikus', 'Alacsony'],
    ['#3', 'OAuth audience validáció hiánya', 'Magas', 'Közepes'],
    ['#4', 'Profil frissítők nem sanitizálnak', 'Magas', 'Alacsony'],
    ['#5', 'RSS feed URL követés DDoS', 'Magas', 'Közepes'],
    ['#6', 'Fiók enumeráció finomhangolása', 'Közepes', 'Alacsony'],
    ['#7', 'Publikus GET végpontok rate limit nélkül', 'Közepes', 'Alacsony'],
    ['#8', 'In-memory rate limiter multi-instance', 'Közepes', 'Alacsony'],
    ['#9', 'Push subscription upsert IDOR', 'Közepes', 'Alacsony'],
    ['#10', 'CSRF guard localhost allowed origin', 'Közepes', 'Alacsony'],
    ['#11', 'JWT iss/aud lax validáció', 'Alacsony', 'Alacsony'],
    ['#12', 'VerificationToken lejárat átugorható', 'Alacsony', 'Alacsony'],
    ['#13', 'GeoIP HTTP fallback', 'Alacsony', 'Alacsony'],
    ['#14', 'Kliensoldali cookie törlés secure flag', 'Alacsony', 'Alacsony'],
    ['#15', 'Feed végpont nem paginál', 'Alacsony', 'Alacsony'],
  ];

  const tableRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        new TableCell({ width: { size: 8, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: '1a1a1a' }, children: [new Paragraph({ children: [new TextRun({ text: '#', bold: true, color: 'FFFFFF' })] })] }),
        new TableCell({ width: { size: 52, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: '1a1a1a' }, children: [new Paragraph({ children: [new TextRun({ text: 'Sebezhetőség', bold: true, color: 'FFFFFF' })] })] }),
        new TableCell({ width: { size: 22, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: '1a1a1a' }, children: [new Paragraph({ children: [new TextRun({ text: 'Súlyosság', bold: true, color: 'FFFFFF' })] })] }),
        new TableCell({ width: { size: 18, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.SOLID, color: '1a1a1a' }, children: [new Paragraph({ children: [new TextRun({ text: 'Javítás igény', bold: true, color: 'FFFFFF' })] })] }),
      ],
    }),
    ...priorityRows.map((row) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: row[0], bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: row[1], size: 20 })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: row[2], size: 20, bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: row[3], size: 20 })] })] }),
        ],
      }),
    ),
  ];

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: tableRows,
    }),
  );

  return new Document({
    creator: 'NuSift Security Audit',
    title: 'NuSift Biztonsági Audit Jelentés',
    description: 'Sebezhetőségi elemzés kategorizálva a súlyosság és javítási sürgősség szerint',
    sections: [{ properties: {}, children }],
  });
}

// ── Document 2: Security Fix Prompt ──────────────────────────────────

function buildFixPrompt(): Document {
  const children: Array<Paragraph | Table> = [];

  // Title
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: 'NuSift Biztonsági Javítási Prompt', bold: true, size: 36, color: '1a1a1a' }),
      ],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({ text: 'Részletes javítási útmutató egy másik AI-nak vagy fejlesztőnek', italics: true, size: 24, color: '666666' }),
      ],
    }),
  );

  // Context
  children.push(heading('Projekt kontextus', HeadingLevel.HEADING_1));
  children.push(p('NuSift egy Nuxt 4 + Vue 3 alkalmazás PostgreSQL adatbázissal (Prisma ORM), JWT-alapú autentikációval (httpOnly cookie-k), web push értesítésekkel, és egy RSS hírfeldolgozó pipeline-nal. A szerveroldal Nitro/H3 event handler-eket használ.'));
  children.push(emptyLine());
  children.push(p('Projekt struktúra:', { bold: true }));
  const structureItems = [
    'Szerver API végpontok: server/api/**/*.ts',
    'Szerver middleware: server/middleware/*.ts',
    'Szerver utils: server/utils/*.ts',
    'Prisma schema: prisma/schema.prisma',
    'Kliensoldal: app/components/*.vue, app/composables/*.ts, app/stores/*.ts',
    'Runtime config: nuxt.config.ts',
    'Teszt framework: vitest (vitest.config.ts)',
    'TypeScript strict mode',
  ];
  for (const item of structureItems) {
    children.push(bullet(item));
  }
  children.push(emptyLine());

  children.push(p('A feladat: javítsd ki az alábbi 14 biztonsági sebezhetőséget SZIGORÚAN súlyossági sorrendben (kritikus → alacsony). Minden javításnál:', { bold: true }));
  const instructions = [
    'Tartsd be a projekt meglévő konvencióit (h3 createError pattern, Prisma query style, TypeScript strict types, NE használj any-t ott ahol lehet elkerülni).',
    'Ne módosítsd a viselkedést a javításon túl.',
    'Minden javítás után futtass typecheck-et: npx nuxt typecheck',
    'Minden javítás után futtass teszteket: npx vitest run',
    'Ha adatbázis-migráció szükséges, futtasd: npx prisma migrate dev',
  ];
  for (const inst of instructions) {
    children.push(bullet(inst));
  }
  children.push(emptyLine());
  children.push(hr());

  // ── PHASE 1 ──
  children.push(heading('PHASE 1 — Kritikus javítások', HeadingLevel.HEADING_1));

  // Fix #1
  children.push(richP([new TextRun({ text: '#1  Dev végpontok admin jogosultság-ellenőrzése', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/dev/ mappában lévő ÖSSZES végpont csak requireUserId(event)-et hív, ami bármely bejelentkezett felhasználónak engedélyezi a hozzáférést. Néhány végpont pusztító műveleteket végez:'));
  const destructiveEndpoints = [
    'agent-logs.delete.ts → törli az ÖSSZES cikket + naplót + pipeline adatot',
    'scoped-source-prune.post.ts → tömeges forrástörlés',
    'http-source-safe-delete.post.ts → forrástörlés',
    'fix-rss-status.post.ts → tömeges adatmódosítás',
    'backfill-article-categories.post.ts → tömeges adatmódosítás',
    'audit-scoped-rss.post.ts → tömeges forrás audit/módosítás',
  ];
  for (const ep of destructiveEndpoints) {
    children.push(bullet(ep));
  }
  children.push(p('A production guard (NODE_ENV === "production" && NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") csak akkor blokkol, ha a flag NINCS true-ra állítva.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('(a) Adj hozzá egy role mezőt a User modellhez prisma/schema.prisma-ban:'));
  children.push(...codeBlock(`model User {
  ...
  role String @default("USER") // "USER" vagy "ADMIN"
  ...
}`));
  children.push(p('(b) Futtass migrációt: npx prisma migrate dev --name add_user_role'));
  children.push(emptyLine());
  children.push(p('(c) Hozd létre a helper-t server/utils/require-admin.ts:'));
  children.push(...codeBlock(`import { prisma } from "./prisma";
import { requireUserId } from "./require-user";
import { createError } from "h3";

export async function requireAdminId(event: any): Promise<string> {
  const userId = requireUserId(event);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user || user.role !== "ADMIN") {
    throw createError({ statusCode: 403, statusMessage: "Admin access required." });
  }
  return userId;
}`));
  children.push(p('(d) Cseréld le az ÖSSZES server/api/dev/*.ts fájlban a requireUserId(event) hívást await requireAdminId(event)-re. FONTOS: requireAdminId async — kell az await!'));
  children.push(p('Érintett fájlok (mindegyikben):'));
  const devFiles = [
    'server/api/dev/agent-logs.delete.ts',
    'server/api/dev/agent-logs.get.ts',
    'server/api/dev/agent-source-count.get.ts',
    'server/api/dev/audit-scoped-rss.post.ts',
    'server/api/dev/backfill-article-categories.post.ts',
    'server/api/dev/fix-rss-status.post.ts',
    'server/api/dev/http-source-merge-audit.get.ts',
    'server/api/dev/http-source-merge-audit.post.ts',
    'server/api/dev/http-source-normalization.get.ts',
    'server/api/dev/http-source-normalization.post.ts',
    'server/api/dev/http-source-safe-delete.post.ts',
    'server/api/dev/import-rss.get.ts',
    'server/api/dev/run-news-pipeline.post.ts',
    'server/api/dev/scoped-source-audit.get.ts',
    'server/api/dev/scoped-source-audit.post.ts',
    'server/api/dev/scoped-source-normalize.post.ts',
    'server/api/dev/scoped-source-prune.post.ts',
  ];
  for (const f of devFiles) {
    children.push(bullet(f));
  }
  children.push(emptyLine());
  children.push(p('Példa (agent-logs.delete.ts):'));
  children.push(...codeBlock(`ELŐTTE:  requireUserId(event);
UTÁNA:   await requireAdminId(event);`));
  children.push(p('(e) Ugyanez a server/api/notifications/run-daily.post.ts fájlban: requireUserId(event) → await requireAdminId(event)'));
  children.push(emptyLine());
  children.push(p('(f) Szigorítsd a production guard-ot a ténylegesen pusztító dev végpontokon. Production-ben MINDIG blokkolva legyenek, függetlenül a NUXT_ALLOW_MANUAL_NOTIFICATION_RUN flag-től:'));
  children.push(...codeBlock(`if (process.env.NODE_ENV === "production") {
  throw createError({ statusCode: 403, statusMessage: "Dev endpoints disabled in production." });
}`));
  children.push(p('A run-news-pipeline.post.ts és run-daily.post.ts esetén maradhat a NUXT_ALLOW_MANUAL_NOTIFICATION_RUN flag, DE az admin ellenőrzés is kötelező marad.'));
  children.push(emptyLine());
  children.push(hr());

  // Fix #2
  children.push(richP([new TextRun({ text: '#2  Seed végpont timing-safe összehasonlítás', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/util/seed-region.post.ts az admin titkos kulcsot egyszerű !== operátorral hasonlítja össze → timing attack lehetősége.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/api/util/seed-region.post.ts fájlban. Fent import: import crypto from \'node:crypto\';'));
  children.push(...codeBlock(`ELŐTTE:
  const providedSecret = getRequestHeader(event, 'x-seed-secret');
  if (!providedSecret || providedSecret !== expectedSecret) {
    throw createError({ statusCode: 403, message: 'Forbidden.' });
  }

UTÁNA:
  const providedSecret = getRequestHeader(event, 'x-seed-secret');
  if (!providedSecret || typeof providedSecret !== 'string') {
    throw createError({ statusCode: 403, message: 'Forbidden.' });
  }
  const expectedBuf = Buffer.from(expectedSecret, 'utf-8');
  const providedBuf = Buffer.from(providedSecret, 'utf-8');
  if (expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw createError({ statusCode: 403, message: 'Forbidden.' });
  }`));
  children.push(emptyLine());
  children.push(hr());

  // ── PHASE 2 ──
  children.push(heading('PHASE 2 — Magas súlyosságú javítások', HeadingLevel.HEADING_1));

  // Fix #3
  children.push(richP([new TextRun({ text: '#3  OAuth Google token audience validáció', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/auth/oauth.post.ts GOOGLE provider ágja csak a userinfo végponthoz küldi a Bearer tokent, de nem ellenőrzi a token audience (aud) vagy authorized party (azp) claim-jét. Így egy másik alkalmazásból származó Google token is felhasználható NuSift fiók-átvételre.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/api/auth/oauth.post.ts fájlban, a GOOGLE provider ágon:'));
  children.push(...codeBlock(`ELŐTTE:
  const googleResponse: any = await $fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: \`Bearer \${token}\` }
  });
  if (!googleResponse?.email) throw new Error("Invalid Google Token");
  verifiedEmail = googleResponse.email;
  verifiedProviderId = googleResponse.sub;

UTÁNA:
  const googleResponse: any = await $fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: \`Bearer \${token}\` }
  });
  if (!googleResponse?.email) throw new Error("Invalid Google Token");

  // Audience validation: verify the token was issued for OUR app
  const expectedClientId = process.env.NUXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (expectedClientId && googleResponse.azp && googleResponse.azp !== expectedClientId) {
    throw new Error("OAuth token audience mismatch");
  }

  verifiedEmail = googleResponse.email;
  verifiedProviderId = googleResponse.sub;`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #4
  children.push(richP([new TextRun({ text: '#4  Profil frissítők szerveroldali bemenet-validációja (XSS)', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/user/profile/identity.put.ts és billing.put.ts nem sanitizálják a bemenetet. A nickname publikus (barátok keresésekor megjelenik), így tárolt XSS-hez vezethet.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('(a) Hozz létre server/utils/sanitize-input.ts:'));
  children.push(...codeBlock(`/**
 * Sanitise a free-text string for safe DB storage.
 * Strips HTML tags + entities, trims, truncates to maxLen.
 */
export function sanitizeText(value: unknown, maxLen: number = 256): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  const stripped = str.replace(/<[^>]*>/g, '');
  const decoded = stripped
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x[0-9a-f]+;/gi, '')
    .replace(/&#[0-9]+;/gi, '');
  const trimmed = decoded.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLen);
}

/**
 * Validate a nickname: alphanumeric + _ . - only.
 */
export function validateNickname(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str.length === 0) return null;
  if (str.length > 64) return null;
  if (!/^[a-zA-Z0-9_.\\-]+$/.test(str)) return null;
  return str;
}`));
  children.push(p('(b) server/api/user/profile/identity.put.ts:'));
  children.push(p('Import: import { sanitizeText, validateNickname } from \'../../../utils/sanitize-input\';'));
  children.push(p('A profileUpdate építésénél:'));
  children.push(...codeBlock(`if (nickname !== undefined) {
  const cleanNick = validateNickname(nickname);
  if (cleanNick === null && nickname) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid nickname format.' });
  }
  profileUpdate.nickname = cleanNick;
}
if (phoneNumber !== undefined) {
  profileUpdate.phoneNumber = sanitizeText(phoneNumber, 32);
}
if (aboutMyself !== undefined) {
  profileUpdate.aboutMyself = sanitizeText(aboutMyself, 1000);
}`));
  children.push(p('A create ágnál is ugyanez a sanitizálás.'));
  children.push(emptyLine());
  children.push(p('(c) server/api/user/profile/billing.put.ts:'));
  children.push(p('Import: import { sanitizeText } from \'../../../utils/sanitize-input\';'));
  children.push(p('Mindkét ágban (update + create):'));
  children.push(...codeBlock(`firstName: sanitizeText(firstName, 64),
lastName: sanitizeText(lastName, 64),
addressLine1: sanitizeText(addressLine1, 256),
addressLine2: sanitizeText(addressLine2, 256),
city: sanitizeText(city, 128),
stateRegion: sanitizeText(stateRegion, 128),
postalCode: sanitizeText(postalCode, 32),
country: sanitizeText(country, 8),
vatNumber: sanitizeText(vatNumber, 64),`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #5
  children.push(richP([new TextRun({ text: '#5  RSS HTML-fallback kérések korlátozása (DDoS amplification)', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/utils/news-pipeline/ingest.ts extractHtmlCandidates függvénye最多 8 linkre indít külön HTTP kérést sorban. Egy rosszindulatú RSS feed visszaélhet ezzel (DDoS amplification a szerver felől).'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/utils/news-pipeline/ingest.ts fájlban extractHtmlCandidates-ben:'));
  children.push(p('(a) Csökkentsd a linkek számát 8-ról 5-re:'));
  children.push(...codeBlock(`ELŐTTE: .slice(0, 8);
UTÁNA:  .slice(0, 5);`));
  children.push(p('(b) Refaktoráld a for ciklust batchelt végrehajtásra (max 2 egyidejű):'));
  children.push(...codeBlock(`const CONCURRENCY = 2;
for (let i = 0; i < links.length; i += CONCURRENCY) {
  const batch = links.slice(i, i + CONCURRENCY);
  const batchResults = await Promise.all(
    batch.map(async (link) => {
      // ... meglévő detailResponse + extractPageMetadata logika ...
      // Return: { candidate: IngestCandidate | null, skipDelta, rejectedItem | null }
    })
  );
  // batchResults feldolgozása: candidates.push, skipSummary +=, rejectedItems.push
}`));
  children.push(p('FONTOS: A meglévő skipSummary és rejectedItems logika eredménye ugyanaz maradjon, csak a végrehajtás módja változzon.', { italic: true }));
  children.push(emptyLine());
  children.push(hr());

  // ── PHASE 3 ──
  children.push(heading('PHASE 3 — Közepes súlyosságú javítások', HeadingLevel.HEADING_1));

  // Fix #6
  children.push(richP([new TextRun({ text: '#6  Publikus GET végpontok rate limiting', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('Ezek a végpontok nem igényelnek autentikációt és nincs rate limiting-jük, így API költség-támadásnak vannak kitéve:'));
  children.push(bullet('server/api/util/get-regional-sources.ts (NewsData.io API-t hív)'));
  children.push(bullet('server/api/util/get-regional-whitelist.ts (fájlrendszer olvasás)'));
  children.push(bullet('server/api/util/get-location.ts (külső GeoIP szolgáltatások)'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('(a) get-regional-sources.ts — adj hozzá rate limiting-et az elejére:'));
  children.push(...codeBlock(`import { assertRateLimit } from "../../utils/rate-limit";
...
await assertRateLimit(event, "regional-sources", 20, 60_000);`));
  children.push(p('MEGJEGYZÉS: Ez egy defineCachedEventHandler — ha a cache miatt a handler nem fut le, a rate limitet a cache előtt kell ellenőrizni (pl. külön middleware-ben).', { italic: true }));
  children.push(emptyLine());
  children.push(p('(b) get-regional-whitelist.ts:'));
  children.push(...codeBlock(`import { assertRateLimit } from '../../utils/rate-limit';
await assertRateLimit(event, "regional-whitelist", 30, 60_000);`));
  children.push(emptyLine());
  children.push(p('(c) get-location.ts:'));
  children.push(...codeBlock(`import { assertRateLimit } from '../../utils/rate-limit';
await assertRateLimit(event, "get-location", 10, 60_000);`));
  children.push(p('Megjegyzés: get-location nem igényel autentikációt (calibration során használják onboarding előtt), de rate limiting kötelező.', { italic: true }));
  children.push(emptyLine());
  children.push(hr());

  // Fix #7
  children.push(richP([new TextRun({ text: '#7  In-memory rate limiter szigorítása production-ben', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/utils/rate-limit.ts fájlban, ha nincs Upstash Redis konfigurálva, csak egy warning-ot ad és in-memory fallback-re vált, ami multi-instance deployment (pl. Vercel serverless) esetén nem működik.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/utils/rate-limit.ts fájlban az in-memory fallback ágon, oszd el a limitet egy konzervatív instance-szám becsléssel:'));
  children.push(...codeBlock(`ELŐTTE:
  if (current.count > limit) {
    throwRateLimitError();
  }

UTÁNA:
  const PROD_INSTANCE_ESTIMATE = 10;
  const effectiveLimit =
    process.env.NODE_ENV === "production" && !upstashReady
      ? Math.max(1, Math.floor(limit / PROD_INSTANCE_ESTIMATE))
      : limit;
  if (current.count > effectiveLimit) {
    throwRateLimitError();
  }`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #8
  children.push(richP([new TextRun({ text: '#8  Push subscription IDOR javítása', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/notifications/subscribe.post.ts upsert endpoint alapján történik, és az update ág felülírja a userId-t. Ha egy támadó ismer egy másik felhasználó push endpoint URL-ét, POST-olhat a saját session-jével és átírhatja a subscription tulajdonosát magára.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/api/notifications/subscribe.post.ts fájlban:'));
  children.push(...codeBlock(`ELŐTTE:
  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      userId,  // ⚠️ Ez felülírja!
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      ...
    },
    create: { userId, endpoint: subscription.endpoint, ... },
  });

UTÁNA:
  // Először ellenőrizzük, hogy az endpoint más user-hez tartozik-e
  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint: subscription.endpoint },
    select: { id: true, userId: true },
  });

  if (existing && existing.userId !== userId) {
    throw createError({
      statusCode: 409,
      statusMessage: "This push endpoint is already registered to another account.",
    });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      // NEM frissítjük a userId-t — csak a kulcsokat
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime,
      isActive: true,
      lastSeenAt: new Date(),
      userAgent: getHeader(event, "user-agent") || null,
      platform: /* meglévő platform logika */,
    },
    create: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime,
      isActive: true,
      lastSeenAt: new Date(),
      userAgent: getHeader(event, "user-agent") || null,
      platform: /* meglévő platform logika */,
    },
  });`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #9
  children.push(richP([new TextRun({ text: '#9  CSRF guard localhost origin szigorítása', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/middleware/csrf-guard.ts fájlban a localhost origin-ek mindig hozzáadódnak az allowed origins-hoz, ha az appUrl tartalmazza a "localhost" vagy "127.0.0.1" string-et. Production-ben is élhet, ha az appUrl véletlenül localhost marad.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/middleware/csrf-guard.ts fájlban:'));
  children.push(...codeBlock(`ELŐTTE:
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://localhost:3001");
    allowedOrigins.add("http://127.0.0.1:3000");
  }

UTÁNA:
  if (process.env.NODE_ENV !== "production" &&
      (appUrl.includes("localhost") || appUrl.includes("127.0.0.1"))) {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://localhost:3001");
    allowedOrigins.add("http://127.0.0.1:3000");
  }`));
  children.push(emptyLine());
  children.push(hr());

  // ── PHASE 4 ──
  children.push(heading('PHASE 4 — Alacsony súlyosságú javítások', HeadingLevel.HEADING_1));

  // Fix #10
  children.push(richP([new TextRun({ text: '#10  JWT iss/aud szigorú validáció', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/utils/auth.ts verifySessionToken függvénye csak opcionálisan validálja az iss és aud claim-eket (backward-compat).'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/utils/auth.ts fájlban verifySessionToken-ben (grace period megközelítéssel):'));
  children.push(...codeBlock(`ELŐTTE:
  if ("iss" in d && d.iss !== TOKEN_ISSUER) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token issuer." });
  }
  if ("aud" in d && d.aud !== TOKEN_AUDIENCE) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token audience." });
  }

UTÁNA (grace period megközelítéssel):
  const STRICT_CLAIMS_FROM = new Date('2026-08-01');
  if (new Date() > STRICT_CLAIMS_FROM) {
    if (d.iss !== TOKEN_ISSUER) {
      throw createError({ statusCode: 401, statusMessage: "Invalid token issuer." });
    }
    if (d.aud !== TOKEN_AUDIENCE) {
      throw createError({ statusCode: 401, statusMessage: "Invalid token audience." });
    }
  } else {
    // Lazsa validáció (backward compat) a grace period alatt
    if ("iss" in d && d.iss !== TOKEN_ISSUER) {
      throw createError({ statusCode: 401, statusMessage: "Invalid token issuer." });
    }
    if ("aud" in d && d.aud !== TOKEN_AUDIENCE) {
      throw createError({ statusCode: 401, statusMessage: "Invalid token audience." });
    }
  }`));
  children.push(p('Frissítsd a server/utils/auth.test.ts teszteket is, hogy a strict validációt teszteljék a grace period után.'));
  children.push(emptyLine());
  children.push(hr());

  // Fix #11
  children.push(richP([new TextRun({ text: '#11  Verification token lejárat kötelező', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/auth/verify.post.ts fájlban, ha a verificationTokenExpires null, a lejárat-ellenőrzés átugródik → a token határozatlan ideig él.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/api/auth/verify.post.ts fájlban:'));
  children.push(...codeBlock(`ELŐTTE:
  if (user.verificationTokenExpires && user.verificationTokenExpires < new Date()) {
    throw createError({ statusCode: 401, statusMessage: 'Verification token has expired...' });
  }

UTÁNA:
  if (!user.verificationTokenExpires || user.verificationTokenExpires < new Date()) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Verification token is invalid or has expired. Please request a new one.'
    });
  }`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #12
  children.push(richP([new TextRun({ text: '#12  GeoIP fallback HTTPS-re váltása', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/util/get-location.ts fallback GeoIP szolgáltatást HTTP-n hívja (ip-api.com), ami MITM-támadásnak kitett.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('A server/api/util/get-location.ts fájlban (használj egy HTTPS-t támogató ingyenes szolgáltatást):'));
  children.push(...codeBlock(`ELŐTTE:
  const fallbackResponse: any = await $fetch('http://ip-api.com/json/', {
    timeout: 4000
  });

UTÁNA:
  const fallbackResponse: any = await $fetch('https://ipwho.is/', {
    timeout: 4000,
    headers: { 'User-Agent': 'NuSift/1.0' }
  });

  // A válasz formátuma: { success: true, country_code: "IE", country: "Ireland" }
  if (fallbackResponse && fallbackResponse.success && fallbackResponse.country_code) {
    return {
      success: true,
      countryCode: fallbackResponse.country_code,
      countryName: fallbackResponse.country
    };
  }
  throw new Error("Invalid response from fallback GeoIP");`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #13
  children.push(richP([new TextRun({ text: '#13  Kliensoldali cookie törlés secure flag', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('Az app/utils/api.ts és app/stores/auth.ts kliensoldali cookie-törlés nem használ secure flag-et, ami production-ben hatástalan lehet (httpOnly cookie-k amúgy sem törölhetők kliensoldalon megbízhatóan).'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('(a) app/utils/api.ts — távolítsd el a cookie-törlést (a szerveroldali /api/auth/logout végpont már megfelelően törli):'));
  children.push(...codeBlock(`ELŐTTE:
  document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";

UTÁNA (egészben távolítsd el a sort, csak a redirect marad):
  // A cookie-kat a szerveroldali /api/auth/logout végpont törli.
  // Itt csak a redirectet végezzük.
  if (import.meta.client) {
    window.location.href = '/auth';
  }`));
  children.push(p('(b) app/stores/auth.ts (Line 85 körül) — ugyanez a minta: távolítsd el a document.cookie törlést, vagy legalább secure flag-gel:'));
  children.push(...codeBlock(`const isHttps = window.location.protocol === 'https:';
document.cookie = \`auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;\${isHttps ? ' secure; sameSite=lax;' : ''}\`;`));
  children.push(emptyLine());
  children.push(hr());

  // Fix #14
  children.push(richP([new TextRun({ text: '#14  Feed végpont pagination', bold: true, size: 26 })]));
  children.push(emptyLine());
  children.push(p('PROBLÉMA:', { bold: true }));
  children.push(p('A server/api/feed.ts nem limitálja a találatok számát → memória- és sávszélesség-terhelés (DoS-közeli állapot) sok forrás esetén.'));
  children.push(emptyLine());
  children.push(p('JAVÍTÁS:', { bold: true }));
  children.push(p('(a) Egyszerű limit:'));
  children.push(...codeBlock(`const FEED_LIMIT = 50;
const articles = await prisma.article.findMany({
  where: { ... },
  orderBy: [{ date: "desc" }, { id: "desc" }],
  take: FEED_LIMIT,
  select: { ... },
});`));
  children.push(p('(b) Opcionális cursor-based pagination (ha a frontend támogatja):'));
  children.push(...codeBlock(`const query = getQuery(event);
const cursor = query.cursor ? Number(query.cursor) : undefined;
const limit = Math.min(Number(query.limit) || 50, 100);

const articles = await prisma.article.findMany({
  where: { ... },
  orderBy: [{ date: "desc" }, { id: "desc" }],
  take: limit,
  ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  select: { ... },
});`));
  children.push(emptyLine());
  children.push(hr());

  // ── Validation section ──
  children.push(heading('Validáció és tesztelés (minden phase után)', HeadingLevel.HEADING_1));
  const validationSteps = [
    'Typecheck: npx nuxt typecheck',
    'Tesztek: npx vitest run',
    'Lint (ha van): npx eslint server/ --ext .ts',
  ];
  for (const step of validationSteps) {
    children.push(bullet(step));
  }
  children.push(emptyLine());
  children.push(p('A #1 javítás után (Prisma migráció):', { bold: true }));
  children.push(...codeBlock(`npx prisma migrate dev --name add_user_role
npx prisma generate`));
  children.push(p('Specifikus tesztek az érintett modulokhoz:', { bold: true }));
  children.push(...codeBlock(`npx vitest run server/utils/auth.test.ts
npx vitest run server/utils/rate-limit.test.ts
npx vitest run server/utils/ssrf-guard.test.ts`));
  children.push(emptyLine());
  children.push(hr());

  // ── Notes section ──
  children.push(heading('Fontos megjegyzések', HeadingLevel.HEADING_1));
  const notes = [
    'A javításokat SÚLYOSSÁGI SORRENDBEN végezd (Phase 1 → 4). Ne ugorj a következőre, amíg az előző nem működik és nincs tesztelve.',
    'A #1 javítás (admin role) adatbázis-migrációt igényel. A meglévő felhasználók role-ja "USER" lesz default-ként. Készíts egy migration script-et (vagy manual SQL-t), ami a meglévő admin felhasználó(k) role-ját "ADMIN"-ra állítja: UPDATE "User" SET role = \'ADMIN\' WHERE email = \'admin@nusift.com\';',
    'A #10 javítás (JWT strict validation) a grace period letelte után MINDEN meglévő session-t invalidál. Vagy használj grace period-t, vagy kommunikáld a felhasználóknak, hogy újra kell jelentkezniük.',
    'A #5 javítás (RSS concurrency) ügyelj arra, hogy a meglévő skipSummary és rejectedItems logika ne sérüljön — csak a végrehajtás módja változzon (soros → batched), az eredmény ugyanaz maradjon.',
    'A #6 javításnál (get-regional-sources rate limit) figyelj arra, hogy defineCachedEventHandler-t használ. Ha a cache miatt a handler nem fut le (cache hit), a rate limit sem fut le. Ebben az esetben vagy tedd a rate limitet a getKey elé, vagy használj globális middleware-t.',
    'A #8 javítás (push IDOR) után a meglévő push subscription-ök, amelyek userId-je már helyes, továbbra is működnek. Csak az új upsert viselkedés változik.',
    'Minden új helper fájl (require-admin.ts, sanitize-input.ts) export-ja legyen typed, és NE használj any-t kivéve ha elkerülhetetlen (pl. event: any a requireUserId mintájára).',
    'Ha bármelyik javítás breaking change (pl. #10, #1), dokumentáld a migration lépéseket egy CHANGELOG_SECURITY.md fájlban.',
  ];
  for (const note of notes) {
    children.push(bullet(note));
  }

  return new Document({
    creator: 'NuSift Security Audit',
    title: 'NuSift Biztonsági Javítási Prompt',
    description: 'Részletes javítási útmutató egy másik AI-nak vagy fejlesztőnek',
    sections: [{ properties: {}, children }],
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const docsDir = path.join(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Generate Audit Report
  console.log('Generating NuSift_Security_Audit_Report.docx ...');
  const auditDoc = buildAuditReport();
  const auditBuffer = await Packer.toBuffer(auditDoc);
  const auditPath = path.join(docsDir, 'NuSift_Security_Audit_Report.docx');
  fs.writeFileSync(auditPath, auditBuffer);
  console.log(`✅ Written: ${auditPath} (${(auditBuffer.length / 1024).toFixed(1)} KB)`);

  // Generate Fix Prompt
  console.log('Generating NuSift_Security_Fix_Prompt.docx ...');
  const fixDoc = buildFixPrompt();
  const fixBuffer = await Packer.toBuffer(fixDoc);
  const fixPath = path.join(docsDir, 'NuSift_Security_Fix_Prompt.docx');
  fs.writeFileSync(fixPath, fixBuffer);
  console.log(`✅ Written: ${fixPath} (${(fixBuffer.length / 1024).toFixed(1)} KB)`);

  console.log('\nDone! Both DOCX files generated in the docs/ folder.');
}

main().catch((err) => {
  console.error('Error generating documents:', err);
  process.exit(1);
});
