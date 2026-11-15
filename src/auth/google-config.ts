/**
 * Google sign-in configuration (design §7.3).
 *
 * Client IDs identify the app to Google. The web ID is used for the redirect flow, and the iOS and
 * Android IDs are accepted as audiences for native ID tokens. Better Auth checks each token's `aud`
 * against this list.
 *
 * Google is enabled only when the web client secret is set, because the redirect flow needs it.
 */
export type GoogleEnv = {
  GOOGLE_CLIENT_ID_WEB?: string;
  GOOGLE_CLIENT_ID_IOS?: string;
  GOOGLE_CLIENT_ID_ANDROID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type GoogleProviderConfig = { clientId: string[]; clientSecret: string };

export function googleProviderConfig(env: GoogleEnv): GoogleProviderConfig | undefined {
  const clientId = [env.GOOGLE_CLIENT_ID_WEB, env.GOOGLE_CLIENT_ID_IOS, env.GOOGLE_CLIENT_ID_ANDROID].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (clientId.length === 0 || !env.GOOGLE_CLIENT_SECRET) return undefined;
  return { clientId, clientSecret: env.GOOGLE_CLIENT_SECRET };
}
