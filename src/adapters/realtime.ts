import Ably from "ably";

/**
 * Live delivery (design §7.10). Ably carries live events only. The database stays the record of every
 * message, so a missed event is recovered by fetching history. Without a key, the adapter is disabled.
 */
export type Realtime = {
  enabled: boolean;
  tokenRequest(clientId: string, capability: Record<string, string[]>): Promise<Record<string, unknown>>;
  publish(channel: string, name: string, data: unknown): Promise<void>;
};

export function createRealtime(apiKey: string | undefined): Realtime {
  if (!apiKey) {
    return {
      enabled: false,
      async tokenRequest() {
        throw new Error("realtime is not configured");
      },
      async publish() {},
    };
  }
  const rest = new Ably.Rest({ key: apiKey });
  return {
    enabled: true,
    async tokenRequest(clientId, capability) {
      const request = await rest.auth.createTokenRequest({
        clientId,
        capability: JSON.stringify(capability),
        ttl: 60 * 60 * 1000,
      });
      return request as unknown as Record<string, unknown>;
    },
    async publish(channel, name, data) {
      await rest.channels.get(channel).publish(name, data);
    },
  };
}
