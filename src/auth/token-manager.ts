
import type {
  TwitchConnectorConfig,
  TwitchValidatedToken,
} from '../api/types.js';
import { TwitchError } from '../errors/twitch-error.js';
import type { DeviceCodeFlow } from './device-code-flow.js';
import type { TwitchTokenStore, TwitchTokens } from './token-store.js';

const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export class TokenManager {
  private refreshPromise: Promise<TwitchTokens> | null = null;

  constructor(
    private readonly config: Pick<
      TwitchConnectorConfig,
      'clientId' | 'scopes' | 'fetch'
    >,
    private readonly tokenStore: TwitchTokenStore,
    private readonly deviceCodeFlow: DeviceCodeFlow,
  ) {}

  private get fetcher(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  async getTokens(): Promise<TwitchTokens> {
    const tokens = await this.tokenStore.load();

    if (!tokens) {
      throw new TwitchError('Not authenticated with Twitch.');
    }

    if (tokens.expiresAt > Date.now() + 60_000) {
      return tokens;
    }

    return this.refreshTokens(tokens);
  }

  async getAccessToken(): Promise<string> {
    return (await this.getTokens()).accessToken;
  }

  async getValidatedToken(): Promise<TwitchValidatedToken> {
    const tokens = await this.getTokens();

    const response = await this.fetcher(TWITCH_VALIDATE_URL, {
      headers: {
        Authorization: `OAuth ${tokens.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new TwitchError(
        'Twitch token validation failed.',
        response.status,
      );
    }

    return (await response.json()) as TwitchValidatedToken;
  }

  async startLogin() {
    return this.deviceCodeFlow.startLogin();
  }

  async completeLogin(signal?: AbortSignal): Promise<TwitchTokens> {
    const response = await this.deviceCodeFlow.waitForAuthorization(signal);

    const tokens: TwitchTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: response.scope,
    };

    await this.tokenStore.save(tokens);
    return tokens;
  }

  async logout(): Promise<void> {
    await this.tokenStore.clear();
  }

  private refreshTokens(current: TwitchTokens): Promise<TwitchTokens> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh(current).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async performRefresh(
    current: TwitchTokens,
  ): Promise<TwitchTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: this.config.clientId,
    });

    const response = await this.fetcher(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new TwitchError(
        'Twitch token refresh failed. You may need to log in again.',
        response.status,
      );
    }

    const result = (await response.json()) as TokenResponse;

    if (
      !result.access_token ||
      !result.refresh_token ||
      !Number.isFinite(result.expires_in)
    ) {
      throw new TwitchError('Twitch returned an invalid refresh response.');
    }

    const tokens: TwitchTokens = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      scopes: result.scope ?? current.scopes,
    };

    await this.tokenStore.save(tokens);
    return tokens;
  }
}
