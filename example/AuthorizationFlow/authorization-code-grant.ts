import { createServer } from 'node:http';
import {
  KeyringTokenStore,
  TwitchClient,
} from 'streamops-twitch-connector';
import {
  KEYRING_ACCOUNT,
  KEYRING_SERVICE,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_SCOPES,
} from '../config.js';

if (!TWITCH_CLIENT_SECRET) {
  throw new Error(
    'Set TWITCH_CLIENT_SECRET in the trusted backend environment before using Authorization Code Grant.',
  );
}

const SERVER_PORT = 3000;
const APP_URL = `http://localhost:${SERVER_PORT}`;
const REDIRECT_URI = `http://localhost:${SERVER_PORT}/callback`;
const tokenStore = new KeyringTokenStore(
  KEYRING_SERVICE,
  KEYRING_ACCOUNT,
);

const twitch = new TwitchClient({
  clientId: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  scopes: TWITCH_SCOPES,
  tokenStore,
});

// This single-user example keeps state in memory. Use the user's server-side
// session instead if you adapt it for a multi-user application.
let expectedState: string | null = null;

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', REDIRECT_URI);

  if (request.method === 'GET' && requestUrl.pathname === '/login') {
    const authorization =
      twitch.tokens.createAuthorizationRequest(REDIRECT_URI);
    expectedState = authorization.state;
    response.writeHead(302, { Location: authorization.authorizationUrl });
    response.end();
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/callback') {
    const twitchError = requestUrl.searchParams.get('error');

    if (twitchError) {
      expectedState = null;
      const description =
        requestUrl.searchParams.get('error_description') ?? twitchError;
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Twitch login was not completed: ${description}`);
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');

    if (!code || !state || !expectedState || state !== expectedState) {
      expectedState = null;
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Login could not be verified. Open /login and try again.');
      return;
    }

    const stateForThisLogin = expectedState;
    expectedState = null;

    try {
      await twitch.tokens.completeAuthorization({
        code,
        state,
        expectedState: stateForThisLogin,
        redirectUri: REDIRECT_URI,
      });

      const result = await twitch.api.get<{
        data: Array<{ login: string; display_name: string }>;
      }>('/users');
      const user = result.data[0];

      if (!user) {
        throw new Error('Twitch did not return the connected account.');
      }

      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Connected as ${user.display_name} (@${user.login}).`);
    } catch (error) {
      console.error('Could not complete Twitch login:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Twitch login failed. Check the server output for details.');
    }

    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Open /login to connect your Twitch account.');
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found.');
});

server.on('error', (error) => {
  console.error('Could not start the example server:', error);
  process.exitCode = 1;
  twitch.tokens.dispose();
});

server.listen(SERVER_PORT, '127.0.0.1', () => {
  console.log(`Example server is running at ${APP_URL}`);
  console.log(`Open ${APP_URL}/login to connect Twitch.`);
  console.log(
    `Register this redirect URL in your Twitch application: ${REDIRECT_URI}`,
  );
});
