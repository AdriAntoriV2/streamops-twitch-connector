
import type { TwitchTokenStore } from '../auth/token-store.js';

export interface TwitchConnectorConfig {
  clientId: string;
  /** Only provide this for a confidential Twitch application. Never embed it in a desktop client. */
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
