import { describe, expect, it, vi } from "vitest";
import { GOOGLE_USERINFO_URL, verifyGoogleAccessToken } from "./google-oauth";

describe("Google OAuth identity verification", () => {
  it("uses the current OpenID UserInfo endpoint and returns verified identity", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      email: " User@Example.com ",
      email_verified: true,
      sub: "google-subject",
    });

    await expect(verifyGoogleAccessToken("token-with-sufficient-length", fetcher)).resolves.toEqual({
      email: "User@Example.com",
      providerId: "google-subject",
    });
    expect(fetcher).toHaveBeenCalledWith(GOOGLE_USERINFO_URL, {
      headers: { Authorization: "Bearer token-with-sufficient-length" },
    });
  });

  it("rejects missing, unverified, or incomplete identities", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      email: "user@example.com",
      email_verified: false,
      sub: "google-subject",
    });

    await expect(verifyGoogleAccessToken("token-with-sufficient-length", fetcher)).rejects.toThrow(
      "invalid_google_identity",
    );
    await expect(verifyGoogleAccessToken(undefined, fetcher)).rejects.toThrow("invalid_google_token");
  });
});
