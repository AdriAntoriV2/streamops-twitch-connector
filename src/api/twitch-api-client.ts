
import type { TwitchConnectorConfig } from './types.js';
import { TokenManager } from '../auth/token-manager.js';
import { TwitchError } from '../errors/twitch-error.js';

const HELIX_BASE_URL = 'https://api.twitch.tv/helix';

export class TwitchApiClient {
  constructor(
    private readonly config: Pick<
      TwitchConnectorConfig,
      'clientId' | 'fetch'
    >,
    private readonly tokenManager: TokenManager,
  ) {}

  private get fetcher(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const accessToken = await this.tokenManager.getAccessToken();
    const url = new URL(
      path.replace(/^\/+/, ''),
      `${HELIX_BASE_URL}/`,
    );

    const headers = new Headers(init.headers);
    headers.set('Client-Id', this.config.clientId);
    headers.set('Authorization', `Bearer ${accessToken}`);

    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.fetcher(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new TwitchError(
        `Twitch Helix request failed (${response.status})${
          responseText ? `: ${responseText}` : ''
        }`,
        response.status,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'DELETE',
    });
  }
}
