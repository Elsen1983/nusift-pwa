export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleIdentity = {
  email: string;
  providerId: string;
};

type GoogleUserInfo = {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
};

type UserInfoFetcher = (
  url: string,
  options: { headers: { Authorization: string } },
) => Promise<GoogleUserInfo>;

export async function verifyGoogleAccessToken(
  token: unknown,
  fetchUserInfo: UserInfoFetcher,
): Promise<GoogleIdentity> {
  if (typeof token !== "string" || token.length < 16 || token.length > 8192) {
    throw new Error("invalid_google_token");
  }

  const profile = await fetchUserInfo(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (
    typeof profile.email !== "string" ||
    !profile.email.trim() ||
    profile.email_verified !== true ||
    typeof profile.sub !== "string" ||
    !profile.sub
  ) {
    throw new Error("invalid_google_identity");
  }

  return {
    email: profile.email.trim(),
    providerId: profile.sub,
  };
}
