# Report: Paywall Detection — Hamis Pozitív Elemzés

**Dátum:** 2026-08-01
**Probléma:** Olyan cikkek is `isPaywall = true` jelölést kapnak, amelyek szabadon elérhetők subscription nélkül.
**Példák:** Bleacher Report, independent.ie

---

## 1. A `isPaywall` jelölés keletkezési helyei

A rendszer **3 helyen** dönti el, hogy egy cikk fizetős-e:

| Fázis | Fájl | Sor | Megoldás |
|-------|------|-----|----------|
| Agent 1 (RSS Import) | `server/utils/news-pipeline/ingest.ts` | 676, 1861 | `/paywall\|subscribe\|premium/i` regex a teljes HTML/XML-en |
| Agent 2 (Discovery) | `server/utils/news-pipeline/article-discovery-helpers.ts` | 1368 | `/paywall\|subscribe\|premium/i` regex a HTML-en vagy title+description-en |
| Agent 3 (Enrichment) | `server/utils/news-pipeline/article-content-extractor.ts` | 137–149, 1896–1937 | Specifikus paywall minták keresése a bodyText-ben és a DOM-ban |

---

## 2. Agent 1 — A fő probléma forrása

### `ingest.ts:676`

```typescript
isPaywall: /paywall|subscribe|premium/i.test(html),
```

### `ingest.ts:1861`

```typescript
isPaywall: /paywall|subscribe|premium/i.test(xml),
```

**Miért problémás?**

Ez a regex a **teljes HTML tartalmat** vizsgálja. Bárhol az oldalon ha szerepel a "subscribe", "premium" vagy "paywall" szó, azonnal `isPaywall = true` lesz.

A legtöbb híroldalon ezek a szavak természetes kontextusban jelennek meg:
- **Navigation:** "Subscribe to our newsletter"
- **Footer:** "Subscribe for exclusive content"
- **Hirdetések:** "Go Premium" banner
- **CTA gombok:** "Subscribe now"
- **Cookie banner:** "premium content"

Ezek egyike sem jelent tényleges paywallt a cikk tartalmára nézve.

### `article-discovery-helpers.ts:1368`

```typescript
const isPaywall = /paywall|subscribe|premium/i.test(html || `${title} ${description}`);
```

Ugyanaz a széles körű regex, itt is hasonló hamis pozitívakat ad.

---

## 3. Agent 3 — A pontosabb detekció (ami nem tudja visszavonni a hamis pozitívat)

### `article-content-extractor.ts:137–149` — PAYWALL_SIGNALS

```typescript
const PAYWALL_SIGNALS: Array<{ pattern: RegExp; strength: "strong" | "weak" }> = [
  { pattern: /subscribe\s+to\s+(continue|read|unlock|access)/i, strength: "strong" },
  { pattern: /sign\s+in\s+to\s+(continue|read|access)/i, strength: "strong" },
  { pattern: /log\s*in\s+to\s+(continue|read|access)/i, strength: "strong" },
  { pattern: /become\s+a\s+(subscriber|member)\s+to/i, strength: "strong" },
  { pattern: /premium\s+(article|content|subscriber)/i, strength: "strong" },
  { pattern: /this\s+(article|content|story)\s+is\s+(for|available\s+to)\s+(subscribers|members)/i, strength: "strong" },
  { pattern: /paywall/i, strength: "strong" },
  { pattern: /access\s+denied/i, strength: "strong" },
  { pattern: /enable\s+javascript\s+to\s+(continue|read|view)/i, strength: "weak" },
  { pattern: /are\s+you\s+a\s+robot/i, strength: "strong" },
  { pattern: /captcha/i, strength: "weak" },
  { pattern: /blocked\s+by\s+security/i, strength: "strong" },
  { pattern: /please\s+disable\s+your\s+ad\s*blocker/i, strength: "weak" },
];
```

### `article-content-extractor.ts:1896–1937` — Detekciós logika

```typescript
function detectPaywallSignals(bodyText: string, doc: Document): PaywallDetection {
  // bodyText és a DOM ellenőrzése a PAYWALL_SIGNALS mintákra
  // ...
  if (strongCount >= 1) return { isPaywall: true, signals };   // 1 erős jel → paywall
  if (weakCount >= 2) return { isPaywall: true, signals };     // 2 gyenge jel → paywall
  return { isPaywall: null, signals };                          // nincs elég bizonyíték
}
```

Ez a detekció **helyesen** működne, de van egy kritikus probléma...

---

## 4. A KULCS PROBLÉMA — Agent 3 nem tudja visszavonni Agent 1 hamis pozitívját

### `enrichment-runtime.ts:937–945` — `buildIsPaywallProvenance`

```typescript
function buildIsPaywallProvenance(
  existingIsPaywall: boolean,
  extractedIsPaywall: boolean | null,
) {
  if (extractedIsPaywall === null) return null;

  // ❌ DON'T overwrite existing true with extracted false
  if (existingIsPaywall && !extractedIsPaywall) {
    return {
      raw: existingIsPaywall,
      chosenValue: existingIsPaywall,  // MEGTARTJA A TRUE-T!
      chosenFrom: "unchanged",
      overrideReason: "Kept Agent 1 paywall=true; extractor found no paywall signal.",
    };
  }
  // ...
}
```

**Ez a kritikus pont:**

1. Agent 1 `isPaywall = true`-t állított (a tág regexszel) → `existingIsPaywall = true`
2. Agent 3 nem talál paywall jeleket → `extractedIsPaywall = false` (vagy `null`)
3. A provenance logika **megtagadja a visszavonást** — megtartja az eredeti `true` értéket
4. **Eredmény:** a cikk véglegesen fizetősnek van jelölve, még ha szabadon elérhető is

---

## 5. Mi történik a UI-ban `isPaywall = true` esetén?

### `app/components/NewsCard.vue:54`
```vue
v-if="article.isPaywall"
```
Fizetős ikon/jelzés megjelenítése a kártyán.

### `app/components/ArticleReaderModal.vue:50`
```vue
<div v-if="article.isPaywall" class="absolute bottom-0 left-0 w-full h-[400px] bg-gradient-to-t from-background via-background/95 to-transparent ...">
```
Az olvasó modalban egy gradiens overlay jelenik meg, ami elfedi a cikk tartalmát és subscription-t kér.

### `app/pages/dashboard/dashboard-main.vue:731, 747`
```typescript
if (activeArticleData.value.isPaywall) {
  // Paywall modal megjelenítése
}
if (article.isPaywall) {
  // Paywall kezelés
}
```

---

## 6. Példa: Bleacher Report

A felhasználó által megadott cikk:
`https://bleacherreport.com/articles/25460391-lebron-james-recruited-use-amtrak-trending-post-amyc-nyc-travel-rumors-after-76ers-contract`

Valószínű trigger:
- A Bleacher Report oldalán a navigation-ban, footer-ben vagy hírlevél szekcióban szerepel a "subscribe" szó
- A `/paywall|subscribe|premium/i` regex triggereli a teljes HTML-ben
- Agent 1 `isPaywall = true`-t állít
- Agent 3 soha nem tudja visszavonni

Ugyanez vonatkozik az **independent.ie**-re is.

---

## 7. Statisztika

A `PAYWALL_BLOCKED` kimenetel az enrichment pipeline-ban:
- `enrichment-persist.ts:468` — `PAYWALL_BLOCKED: 0` alapértelmezett számláló
- `enrichment.ts:376` — A `PAYWALL_BLOCKED` végleges elutasítási kód

---

## 8./javaslatok

### Megoldás 1: Agent 1 regex szűkítése (LEGGYORSABB)

```typescript
// INNEN (tág):
isPaywall: /paywall|subscribe|premium/i.test(html),

// IDE (specifikusabb):
isPaywall: /paywall|subscribe\s+to\s+(continue|read|unlock)|this\s+(article|content)\s+is\s+(for|available\s+to)\s+(subscribers|members)|premium\s+(article|content)/i.test(html),
```

**Előny:** Egyszerű, egy soros változtatás
**Hátrány:** Nem tökéletes, de drasztikusan csökkenti a hamis pozitívokat

### Megoldás 2: Agent 3 engedélyezése a visszavonásra

```typescript
// INNEN (soha nem cáfolja meg):
if (existingIsPaywall && !extractedIsPaywall) {
  return { chosenValue: existingIsPaywall, ... };
}

// IDE (engedélyezi a visszavonást ha a cikk sikeresen extrahálható):
if (existingIsPaywall && !extractedIsPaywall) {
  // Ha Agent 3 sikeresen kinyerte a bodyText-et (nincs paywall blokkolás),
  // akkor megbízunk benne hogy a cikk elérhető
  return {
    chosenValue: false,
    chosenFrom: "dom",
    overrideReason: "Extractor found no paywall signal; article body fully extracted.",
  };
}
```

**Előny:** Pontos, Agent 3 tudása alapján dönt
**Hátrány:** Nagyobb hatású változtatás

### Megoldás 3: Mindkettő együtt (LEGBIZTOSABB)

Mindkét fenti változtatás egyszerre alkalmazása.

---

## 9. Érintett fájlok

| Fájl | Változtatás szükséges |
|------|----------------------|
| `server/utils/news-pipeline/ingest.ts` | Agent 1 regex szűkítése (sor 676, 1861) |
| `server/utils/news-pipeline/article-discovery-helpers.ts` | Agent 2 regex szűkítése (sor 1368) |
| `server/utils/news-pipeline/enrichment-runtime.ts` | Agent 3 provenance engedélyezése (sor 937–945) |
| `server/utils/news-pipeline/article-content-extractor.ts` | Meglévő pontos detekció — változtatás nem szükséges |

---

## 10. Tesztelés

A változtatások után:

1. **Unit tesztek futtatása:** `npx vitest run` (a `article-content-extractor.test.ts` és `enrichment-runtime.test.ts` fájlok)
2. **Manuális teszt:** Bleacher Report és independent.ie cikkek ellenőrzése
3. **Adatbázis ellenőrzés:** Meglévő `isPaywall = true` cikkek számának csökkenése
