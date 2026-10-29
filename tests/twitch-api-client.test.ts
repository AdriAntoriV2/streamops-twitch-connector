import { describe, expect, it, vi } from 'vitest';
import { TwitchApiClient } from '../src/api/twitch-api-client.js';
import type { TokenManager } from '../src/auth/token-manager.js';

describe('TwitchApiClient', () => {
  it('adds Twitch authentication headers to requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const tokenManager = {
      getAccessToken: vi.fn().mockResolvedValue('test-access-token'),
      refreshAfterUnauthorized: vi.fn(),
    } as unknown as TokenManager;

    const client = new TwitchApiClient(
      {
        clientId: 'test-client-id',
        fetch: fetchMock,
      },
      tokenManager,
    );

    const result = await client.get<{ data: unknown[] }>('/users');

    expect(result).toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];

    expect(String(url)).toBe('https://api.twitch.tv/helix/users');
    expect(new Headers(init?.headers).get('Client-Id')).toBe(
      'test-client-id',
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-access-token',
    );
  });

  it('refreshes and retries once when Helix returns 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const tokenManager = {
      getAccessToken: vi.fn().mockResolvedValue('expired-token'),
      refreshAfterUnauthorized: vi.fn().mockResolvedValue('new-access-token'),
    } as unknown as TokenManager;

    const client = new TwitchApiClient(
      {
        clientId: 'test-client-id',
        fetch: fetchMock,
      },
      tokenManager,
    );

    await expect(client.get('/users')).resolves.toEqual({ data: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenManager.refreshAfterUnauthorized).toHaveBeenCalledWith(
      'expired-token',
    );
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization'),
    ).toBe('Bearer new-access-token');
  });

  it('does not retry a streaming request body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );
    const tokenManager = {
      getAccessToken: vi.fn().mockResolvedValue('expired-token'),
      refreshAfterUnauthorized: vi.fn(),
    } as unknown as TokenManager;
    const client = new TwitchApiClient(
      { clientId: 'test-client-id', fetch: fetchMock },
      tokenManager,
    );

    await expect(
      client.request('/chat/messages', {
        method: 'POST',
        body: new ReadableStream<Uint8Array>(),
      }),
    ).rejects.toThrow('Twitch Helix request failed (401)');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenManager.refreshAfterUnauthorized).not.toHaveBeenCalled();
  });
});
