import { describe, expect, it, vi } from 'vitest';
import { AuthorizationCodeFlow } from '../src/auth/authorization-code-flow.js';

function createFlow(fetchMock: typeof fetch) {
  return new AuthorizationCodeFlow({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scopes: ['user:read:chat', 'user:write:chat'],
    fetch: fetchMock,
  });
}

describe('AuthorizationCodeFlow', () => {
  it('creates a Twitch authorization URL and secure state', () => {
    const flow = createFlow(vi.fn<typeof fetch>());
    const request = flow.createAuthorizationRequest(
      'https://example.test/twitch/callback',
    );
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      'https://id.twitch.tv/oauth2/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.test/twitch/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(
      'user:read:chat user:write:chat',
    );
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(request.state).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exchanges a callback code and URL-encodes all credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh&token',
          expires_in: 3600,
          scope: ['user:read:chat'],
          token_type: 'bearer',
        }),
        { status: 200 },
      ),
    );
    const flow = createFlow(fetchMock);

    await expect(
      flow.exchangeCode({
        code: 'code&with/special+characters',
        redirectUri: 'https://example.test/twitch/callback',
        state: 'returned-state',
        expectedState: 'returned-state',
      }),
    ).resolves.toMatchObject({
      access_token: 'access-token',
      refresh_token: 'refresh&token',
      scope: ['user:read:chat'],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('test-client-id');
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('code')).toBe('code&with/special+characters');
    expect(body.get('redirect_uri')).toBe(
      'https://example.test/twitch/callback',
    );
  });

  it('rejects a callback with a state mismatch without contacting Twitch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const flow = createFlow(fetchMock);

    await expect(
      flow.exchangeCode({
        code: 'authorization-code',
        redirectUri: 'https://example.test/twitch/callback',
        state: 'attacker-state',
        expectedState: 'session-state',
      }),
    ).rejects.toMatchObject({
      errorCode: 'authorization_state_mismatch',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
