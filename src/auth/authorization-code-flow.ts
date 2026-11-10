import type { TwitchConnectorConfig } from '../api/types.js';
import { TwitchError } from '../errors/twitch-error.js';

const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export interface TwitchAuthorizationRequest {
  redirectUri: string;
  state: string;
}

export interface TwitchAuthorizationRequestResult {
  authorizationUrl: string;
  state: string;
}

export interface TwitchAuthorizationCallback {
  code: string;
  redirectUri: string;
  state: string;
  expectedState: string;
}

export interface AuthorizationCodeTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

export class AuthorizationCodeFlow {
  constructor(
    private readonly config: Pick<
      TwitchConnectorConfig,
      'clientId' | 'clientSecret' | 'scopes' | 'fetch'
    >,
  ) {}

  createAuthorizationRequest(
    redirectUri: string,
  ): TwitchAuthorizationRequestResult {
    if (!redirectUri) {
      throw new TwitchError(
        'A redirect URI is required.',
        undefined,
        'invalid_authorization_request',
      );
    }

    if (!globalThis.crypto?.getRandomValues) {
      throw new TwitchError(
        'A secure random source is required to start Twitch authorization.',
        undefined,
        'secure_random_unavailable',
      );
    }

    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const state = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');

    return {
      authorizationUrl: this.createAuthorizationUrl({ redirectUri, state }),
      state,
    };
  }

  createAuthorizationUrl(request: TwitchAuthorizationRequest): string {
    if (!request.redirectUri || !request.state) {
      throw new TwitchError(
        'A redirect URI and OAuth state are required.',
        undefined,
        'invalid_authorization_request',
      );
    }

    const url = new URL(TWITCH_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state: request.state,
    }).toString();

    return url.toString();
  }

  async exchangeCode(
    callback: TwitchAuthorizationCallback,
  ): Promise<AuthorizationCodeTokenResponse> {
    if (!this.config.clientSecret) {
      throw new TwitchError(
        'A client secret is required for Authorization Code Grant. Keep it on a trusted server.',
        undefined,
        'client_secret_required',
      );
    }

    if (!callback.code || !callback.redirectUri) {
      throw new TwitchError(
        'An authorization code and redirect URI are required.',
        undefined,
        'invalid_authorization_callback',
      );
    }

    if (!callback.expectedState || callback.state !== callback.expectedState) {
      throw new TwitchError(
        'Twitch authorization state did not match. Start login again.',
        undefined,
        'authorization_state_mismatch',
      );
    }

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: callback.code,
      grant_type: 'authorization_code',
      redirect_uri: callback.redirectUri,
    });

    let response: Response;

    try {
      response = await (this.config.fetch ?? fetch)(TWITCH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (cause) {
      throw new TwitchError(
        'Unable to contact Twitch to exchange the authorization code.',
        undefined,
        'authorization_exchange_network_error',
        { cause },
      );
    }

    let data: unknown;

    try {
      data = await response.json();
    } catch (cause) {
      throw new TwitchError(
        'Twitch returned an invalid authorization response.',
        response.status,
        'invalid_oauth_response',
        { cause },
      );
    }

    if (!response.ok) {
      throw new TwitchError(
        'Twitch authorization code exchange failed.',
        response.status,
        response.status === 400 || response.status === 401
          ? 'reauthentication_required'
          : 'authorization_exchange_failed',
      );
    }

    if (!data || typeof data !== 'object') {
      throw new TwitchError(
        'Twitch returned an invalid authorization token response.',
        response.status,
        'invalid_token_response',
      );
    }

    const token = data as Partial<AuthorizationCodeTokenResponse>;

    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      typeof token.refresh_token !== 'string' ||
      !token.refresh_token ||
      typeof token.expires_in !== 'number' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 ||
      !Array.isArray(token.scope) ||
      !token.scope.every((scope) => typeof scope === 'string')
    ) {
      throw new TwitchError(
        'Twitch returned an invalid authorization token response.',
        response.status,
        'invalid_token_response',
      );
    }

    return token as AuthorizationCodeTokenResponse;
  }
}
