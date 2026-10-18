
import type { TwitchTokenStore } from '../auth/token-store.js';

export interface TwitchConnectorConfig {
  clientId: string;
  scopes: string[];
  tokenStore: TwitchTokenStore;
  fetch?: typeof fetch;
}

export interface TwitchValidatedToken {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}
