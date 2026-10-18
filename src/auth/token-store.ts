
export interface TwitchTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
  scopes: string[];
}

export interface TwitchTokenStore {
  load(): Promise<TwitchTokens | null>;
  save(tokens: TwitchTokens): Promise<void>;
  clear(): Promise<void>;
}
