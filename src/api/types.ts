
import type { TwitchTokenStore } from '../auth/token-store.js';

export interface TwitchConnectorConfig {
  clientId: string;
  /** Required for Authorization Code Grant. Keep it on a trusted server; never expose it to clients. */
  clientSecret?: string;
  scopes: string[];
  tokenStore: TwitchTokenStore;
  fetch?: typeof fetch;
}

export interface TwitchValidatedToken {
  client_id: string;
  login: string | null;
  scopes: string[];
  user_id: string | null;
  expires_in: number;
}
