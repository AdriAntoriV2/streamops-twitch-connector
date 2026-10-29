
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
  scope?: string[];
  token_type?: string;
}

const TOKEN_VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

export class TokenManager {
  private refreshPromise: Promise<TwitchTokens> | null = null;
  private validationPromise: Promise<TwitchValidatedToken> | null = null;
  private validationTimer: ReturnType<typeof setTimeout> | null = null;
  private lastValidatedAt = 0;
  private lastAuthError: Error | null = null;
  private validationMonitoring = true;
  private readonly authErrorHandlers = new Set<(error: Error) => void>();

  constructor(
    private readonly config: Pick<
      TwitchConnectorConfig,
      'clientId' | 'clientSecret' | 'scopes' | 'fetch'
    >,
    private readonly tokenStore: TwitchTokenStore,
    private readonly deviceCodeFlow: DeviceCodeFlow,
  ) {}

  private get fetcher(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  /** Loads persisted token metadata without attempting an expiry-based refresh. */
  async getTokens(): Promise<TwitchTokens> {
    const tokens = await this.tokenStore.load();

    if (!tokens) {
      throw new TwitchError('Not authenticated with Twitch.');
    }

    return tokens;
  }

  async getAccessToken(): Promise<string> {
    await this.validateIfDue();
    return (await this.getTokens()).accessToken;
  }

  async getValidatedToken(): Promise<TwitchValidatedToken> {
    return this.validateCurrentTokens();
  }

  /** Force a refresh without requiring the consuming application to restart. */
  async refresh(): Promise<TwitchTokens> {
    const tokens = await this.tokenStore.load();

    if (!tokens) {
      throw new TwitchError('Not authenticated with Twitch.');
    }

    return this.refreshTokens(tokens);
  }

  /**
   * Refresh after Helix rejects a token. Concurrent requests reuse a refresh
   * already performed by another request when the store has the newer token.
   */
  async refreshAfterUnauthorized(
    rejectedAccessToken: string,
  ): Promise<string> {
    const tokens = await this.tokenStore.load();

    if (!tokens) {
      throw new TwitchError('Not authenticated with Twitch.');
    }

    const refreshed =
      tokens.accessToken === rejectedAccessToken
        ? await this.refreshTokens(tokens)
        : tokens;

    return refreshed.accessToken;
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
    this.lastValidatedAt = 0;
    this.validationMonitoring = true;
    return tokens;
  }

  async logout(): Promise<void> {
    this.validationMonitoring = false;
    this.stopValidationTimer();
    this.lastValidatedAt = 0;
    this.lastAuthError = null;
    await this.tokenStore.clear();
  }

  onAuthError(handler: (error: Error) => void): () => void {
    this.authErrorHandlers.add(handler);
    return () => this.authErrorHandlers.delete(handler);
  }

  get authError(): Error | null {
    return this.lastAuthError;
  }

  dispose(): void {
    this.validationMonitoring = false;
    this.stopValidationTimer();
  }

  private validateIfDue(): Promise<void> {
    if (
      this.lastValidatedAt > 0 &&
      Date.now() - this.lastValidatedAt < TOKEN_VALIDATION_INTERVAL_MS
    ) {
      return Promise.resolve();
    }

    if (this.validationPromise) {
      return this.validationPromise.then(() => undefined);
    }

    this.validationPromise = this.validateCurrentTokens().finally(
      () => {
        this.validationPromise = null;
      },
    );

    return this.validationPromise.then(() => undefined);
  }

  private async validateCurrentTokens(): Promise<TwitchValidatedToken> {
    const tokens = await this.getTokens();
    let response = await this.validate(tokens.accessToken);

    if (response.status === 401) {
      const refreshed = await this.refreshTokens(tokens);
      response = await this.validate(refreshed.accessToken);
    }

    if (!response.ok) {
      throw new TwitchError(
        'Twitch token validation failed.',
        response.status,
        response.status === 401 ? 'reauthentication_required' : undefined,
      );
    }

    const validated = (await response.json()) as TwitchValidatedToken;

    if (
      validated.client_id !== this.config.clientId ||
      !Number.isFinite(validated.expires_in) ||
      validated.expires_in <= 0
    ) {
      throw new TwitchError(
        'Twitch token validation returned unexpected token details.',
        response.status,
        'invalid_validated_token',
      );
    }

    const currentTokens = await this.tokenStore.load();

    if (currentTokens?.accessToken === tokens.accessToken) {
      await this.tokenStore.save({
        ...currentTokens,
        expiresAt: Date.now() + validated.expires_in * 1000,
      });
    }

    this.lastValidatedAt = Date.now();
    this.lastAuthError = null;
    this.scheduleValidation();
    return validated;
  }

  private validate(accessToken: string): Promise<Response> {
    return this.fetcher(TWITCH_VALIDATE_URL, {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });
  }

  private scheduleValidation(): void {
    if (!this.validationMonitoring) {
      return;
    }

    this.stopValidationTimer();
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      void this.validateCurrentTokens()
        .catch((error: unknown) => {
          const authError =
            error instanceof Error ? error : new Error(String(error));
          this.lastAuthError = authError;

          for (const handler of this.authErrorHandlers) {
            handler(authError);
          }
        })
        .finally(() => this.scheduleValidation());
    }, TOKEN_VALIDATION_INTERVAL_MS);

    const timer = this.validationTimer as unknown as {
      unref?: () => void;
    };
    timer.unref?.();
  }

  private stopValidationTimer(): void {
    if (this.validationTimer) {
      clearTimeout(this.validationTimer);
      this.validationTimer = null;
    }
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

    if (this.config.clientSecret) {
      body.set('client_secret', this.config.clientSecret);
    }

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
        response.status === 400 || response.status === 401
          ? 'reauthentication_required'
          : 'token_refresh_failed',
      );
    }

    const result = (await response.json()) as TokenResponse;

    if (
      !result.access_token ||
      !result.refresh_token ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    ) {
      throw new TwitchError('Twitch returned an invalid refresh response.');
    }

    const tokens: TwitchTokens = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      scopes: Array.isArray(result.scope) ? result.scope : current.scopes,
    };

    await this.tokenStore.save(tokens);
    this.lastValidatedAt = 0;
    return tokens;
  }
}
