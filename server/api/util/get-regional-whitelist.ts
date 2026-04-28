// server/api/util/get-regional-whitelist.ts
import fs from 'node:fs/promises';
import path from 'node:path';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const country = (query.country as string)?.toUpperCase();

  if (!country) {
    return { success: false, sources: [] };
  }

  try {
    const filePath = path.join(process.cwd(), 'data', 'sources', `${country}.json`);
    
    // Read the local JSON database
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const parsedData = JSON.parse(fileContent);

    return {
      success: true,
      region: country,
      count: parsedData.sourceCount,
      sources: parsedData.domains // Array of strings (e.g., ['irishtimes.com', 'rte.ie'])
    };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.warn(`[Whitelist API] No local database found for ${country}.`);
    } else {
      console.error(`[Whitelist API] Error reading database for ${country}:`, error.message);
    }
    return { success: false, sources: [] };
  }
});