// server/api/util/get-location.ts
export default defineEventHandler(async (event) => {
  try {
    // 1. Próbálkozás: ipapi.co (Böngésző szimulációval)
    const response: any = await $fetch('https://ipapi.co/json/', {
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (response && response.country_code) {
      return {
        success: true,
        countryCode: response.country_code,
        countryName: response.country_name
      };
    }
    throw new Error("Invalid response from primary GeoIP");

  } catch (error) {
    // 2. Próbálkozás (Fallback): ip-api.com
    try {
      const fallbackResponse: any = await $fetch('http://ip-api.com/json/', { 
        timeout: 4000 
      });
      
      if (fallbackResponse && fallbackResponse.status === 'success') {
        return {
          success: true,
          countryCode: fallbackResponse.countryCode,
          countryName: fallbackResponse.country
        };
      }
      throw new Error("Invalid response from fallback GeoIP");
    } catch (fallbackErr) {
      console.error("Sovereign Shield: Both GeoIP services failed.");
      return { success: false, message: 'Location detection failed' };
    }
  }
});