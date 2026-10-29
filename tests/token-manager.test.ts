import { describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../src/auth/token-manager.js';
import type { TwitchTokens } from '../src/auth/token-store.js';
import type { DeviceCodeFlow } from '../src/auth/device-code-flow.js';

function createManager(
  initialTokens: TwitchTokens,
  fetchMock: typeof fetch,
  clientSecret?: string,
) {
  let storedTokens: TwitchTokens | null = initialTokens;
  const tokenStore = {
    load: vi.fn(async () => storedTokens),
    save: vi.fn(async (tokens: TwitchTokens) => {
      storedTokens = tokens;
    }),
    clear: vi.fn(async () => {
      storedTokens = null;
    }),
  };
  const manager = new TokenManager(
    {
      clientId: 'test-client-id',
      clientSecret,
      scopes: [],
      fetch: fetchMock,
    },
    tokenStore,
    {} as DeviceCodeFlow,
  );

  return { manager, tokenStore, getStoredTokens: () => storedTokens };
}

function tokens(overrides: Partial<TwitchTokens> = {}): TwitchTokens {
  return {
    accessToken: 'old-access-token',
    refreshToken: 'old&refresh/token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:read:chat'],
    ...overrides,
  };
}

describe('TokenManager', () => {
  it('validates on first use and does not validate again within the hour', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: 'test-client-id',
          login: 'streamer',
          scopes: ['user:read:chat'],
          user_id: 'user-123',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const { manager, tokenStore } = createManager(tokens(), fetchMock);

    await expect(manager.getAccessToken()).resolves.toBe(
      'old-access-token',
    );
    await expect(manager.getAccessToken()).resolves.toBe(
      'old-access-token',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore.save).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not refresh just because the stored expiry time has passed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: 'test-client-id',
          login: 'streamer',
          scopes: ['user:read:chat'],
          user_id: 'user-123',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const { manager } = createManager(
      tokens({ expiresAt: Date.now() - 1000 }),
      fetchMock,
    );

    await expect(manager.getAccessToken()).resolves.toBe(
      'old-access-token',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://id.twitch.tv/oauth2/validate',
    );
    manager.dispose();
  });

  it('refreshes and retries validation when Twitch returns 401', async () => {
    const validation = {
      client_id: 'test-client-id',
      login: 'streamer',
      scopes: ['user:read:chat'],
      user_id: 'user-123',
      expires_in: 3600,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 7200,
            scope: ['user:read:chat'],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validation), { status: 200 }),
      );
    const { manager, getStoredTokens } = createManager(
      tokens({ expiresAt: Date.now() - 1000 }),
      fetchMock,
    );

    await expect(manager.getAccessToken()).resolves.toBe('new-access-token');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getStoredTokens()?.refreshToken).toBe('new-refresh-token');
    manager.dispose();
  });

  it('refreshes with a rotated refresh token and optional client secret', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: ['user:read:chat', 'user:write:chat'],
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );
    const { manager, getStoredTokens } = createManager(
      tokens(),
      fetchMock,
      'confidential-secret',
    );

    await expect(manager.refresh()).resolves.toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      scopes: ['user:read:chat', 'user:write:chat'],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('refresh_token')).toBe('old&refresh/token');
    expect(body.get('client_secret')).toBe('confidential-secret');
    expect(getStoredTokens()?.refreshToken).toBe('new-refresh-token');
  });

  it('requires reauthorization when Twitch rejects the refresh token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
        { status: 401 },
      ),
    );
    const { manager } = createManager(tokens(), fetchMock);

    await expect(manager.refresh()).rejects.toMatchObject({
      errorCode: 'reauthentication_required',
      statusCode: 401,
    });
  });
});
