
import type { TwitchConnectorConfig } from '../api/types.js';
import { TwitchError } from '../errors/twitch-error.js';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceCodeTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export interface DeviceCodeLogin {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface OAuthErrorResponse {
  error?: string;
  message?: string;
  status?: number;
}

export class DeviceCodeFlow {
  private readonly fetchImpl: typeof fetch;
  private deviceCode: string | null = null;
  private expiresAt = 0;
  private pollInterval = 5;
  private loginInProgress = false;

  constructor(private readonly config: TwitchConnectorConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  async startLogin(): Promise<DeviceCodeLogin> {
    if (this.loginInProgress || this.deviceCode !== null) {
      throw new TwitchError(
        'A Twitch device login is already active.',
        undefined,
        'login_already_active',
      );
    }

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      scopes: this.config.scopes.join(' '),
    });

    let response: Response;

    try {
      response = await this.fetchImpl(
        'https://id.twitch.tv/oauth2/device',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );
    } catch (cause) {
      throw new TwitchError(
        'Unable to contact Twitch to start device login.',
        undefined,
        'device_login_network_error',
        { cause },
      );
    }

    const data = await this.readResponse(response, 'start device login');

    if (!response.ok) {
      const error = this.asOAuthError(data);

      throw new TwitchError(
        error.message ??
          error.error ??
          'Failed to start Twitch device login.',
        response.status,
        error.error ?? 'device_login_failed',
      );
    }

    const result = data as Partial<DeviceCodeResponse>;

    if (
      typeof result.device_code !== 'string' ||
      !result.device_code ||
      typeof result.user_code !== 'string' ||
      !result.user_code ||
      typeof result.verification_uri !== 'string' ||
      !result.verification_uri ||
      typeof result.expires_in !== 'number' ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    ) {
      throw new TwitchError(
        'Twitch returned an invalid device login response.',
        response.status,
        'invalid_device_response',
      );
    }

    this.deviceCode = result.device_code;
    this.expiresAt = Date.now() + result.expires_in * 1000;
    this.pollInterval =
      typeof result.interval === 'number' && result.interval > 0
        ? result.interval
        : 5;

    return {
      userCode: result.user_code,
      verificationUri: result.verification_uri,
      expiresIn: result.expires_in,
      interval: this.pollInterval,
    };
  }

  async waitForAuthorization(
    signal?: AbortSignal,
  ): Promise<DeviceCodeTokenResponse> {
    const deviceCode = this.deviceCode;

    if (!deviceCode) {
      throw new TwitchError(
        'No active device login. Call startLogin() first.',
        undefined,
        'no_active_device_login',
      );
    }

    if (this.loginInProgress) {
      throw new TwitchError(
        'Device authorization polling is already active.',
        undefined,
        'login_poll_already_active',
      );
    }

    this.loginInProgress = true;

    try {
      while (Date.now() < this.expiresAt) {
        await this.delay(this.pollInterval * 1000, signal);

        if (signal?.aborted) {
          throw new TwitchError(
            'Twitch device login was cancelled.',
            undefined,
            'login_cancelled',
          );
        }

        const body = new URLSearchParams({
          client_id: this.config.clientId,
          device_code: deviceCode,
          grant_type:
            'urn:ietf:params:oauth:grant-type:device_code',
        });

        let response: Response;

        try {
          response = await this.fetchImpl(
            'https://id.twitch.tv/oauth2/token',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body,
              signal,
            },
          );
        } catch (cause) {
          if (signal?.aborted) {
            throw new TwitchError(
              'Twitch device login was cancelled.',
              undefined,
              'login_cancelled',
              { cause },
            );
          }

          throw new TwitchError(
            'Unable to contact Twitch while waiting for device authorization.',
            undefined,
            'device_login_network_error',
            { cause },
          );
        }

        const data = await this.readResponse(
          response,
          'poll device login',
        );

        if (response.ok) {
          const token = data as Partial<DeviceCodeTokenResponse>;

          if (
            typeof token.access_token !== 'string' ||
            typeof token.refresh_token !== 'string' ||
            typeof token.expires_in !== 'number' ||
            !Array.isArray(token.scope)
          ) {
            throw new TwitchError(
              'Twitch returned an invalid device token response.',
              response.status,
              'invalid_token_response',
            );
          }

          return token as DeviceCodeTokenResponse;
        }

        const error = this.asOAuthError(data);

        switch (error.error) {
          case 'authorization_pending':
            continue;

          case 'slow_down':
            this.pollInterval += 5;
            continue;

          case 'access_denied':
            throw new TwitchError(
              'Twitch device login was denied by the user.',
              response.status,
              'access_denied',
            );

          case 'expired_token':
            throw new TwitchError(
              'The Twitch device login code has expired.',
              response.status,
              'device_code_expired',
            );

          default:
            throw new TwitchError(
              error.message ??
                error.error ??
                'Twitch device authorization failed.',
              response.status,
              error.error ?? 'device_authorization_failed',
            );
        }
      }

      throw new TwitchError(
        'The Twitch device login code has expired.',
        undefined,
        'device_code_expired',
      );
    } finally {
      this.deviceCode = null;
      this.expiresAt = 0;
      this.pollInterval = 5;
      this.loginInProgress = false;
    }
  }

  private async readResponse(
    response: Response,
    action: string,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new TwitchError(
        `Twitch returned an invalid response while attempting to ${action}.`,
        response.status,
        'invalid_oauth_response',
        { cause },
      );
    }
  }

  private asOAuthError(value: unknown): OAuthErrorResponse {
    if (!value || typeof value !== 'object') {
      return {};
    }

    const data = value as Record<string, unknown>;

    return {
      error:
        typeof data.error === 'string'
          ? data.error
          : undefined,
      message:
        typeof data.message === 'string'
          ? data.message
          : undefined,
      status:
        typeof data.status === 'number'
          ? data.status
          : undefined,
    };
  }

  private delay(
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new TwitchError(
            'Twitch device login was cancelled.',
            undefined,
            'login_cancelled',
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        reject(
          new TwitchError(
            'Twitch device login was cancelled.',
            undefined,
            'login_cancelled',
          ),
        );
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
