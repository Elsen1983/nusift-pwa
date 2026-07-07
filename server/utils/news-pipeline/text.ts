import { normalizeFeedTextDetailed } from "./normalize-feed-text";

export const decodeHtmlEntities = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const stripCdata = (input: string) =>
  input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");

export const repairMojibake = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const normalizeFeedText = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const cleanFeedValue = (input: string) => normalizeFeedText(input);

export const normalizeUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  url.hash = "";
  url.searchParams.delete("utm_source");
  url.searchParams.delete("utm_medium");
  url.searchParams.delete("utm_campaign");
  url.searchParams.delete("utm_term");
  url.searchParams.delete("utm_content");
  url.searchParams.delete("fbclid");
  url.searchParams.delete("gclid");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
};

export const stripHtml = (input: string) =>
  normalizeFeedText(
    input
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

export const hashText = async (input: string) => {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
