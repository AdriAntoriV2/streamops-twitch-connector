
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

  it('throws TwitchError when Helix returns an HTTP error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );

    const tokenManager = {
      getAccessToken: vi.fn().mockResolvedValue('expired-token'),
    } as unknown as TokenManager;

    const client = new TwitchApiClient(
      {
        clientId: 'test-client-id',
        fetch: fetchMock,
      },
      tokenManager,
    );

    await expect(client.get('/users')).rejects.toThrow(
      'Twitch Helix request failed (401)',
    );
  });
});
