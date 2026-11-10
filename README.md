# StreamOps Twitch Connector

A small, framework-independent TypeScript library for Twitch OAuth, Helix,
chat, and EventSub. The product owns its Twitch application, callback route,
and secure token storage; the connector handles Twitch requests and token
refreshing. It supports both Device Code Grant (DCF) and Authorization Code
Grant (ACF); either flow uses the same API, chat, EventSub, and token store.

## Requirements

- Node.js 22 or newer
- A Twitch application registered for each product
- A backend that can keep the client secret private if using Authorization
  Code Grant
- A token store supplied by the product

Never put a Twitch client secret or refresh token in a browser or desktop
client. Have those clients call your backend instead.

## Quick start

Install the package and create one `TwitchClient` in your backend. Use a
durable `TwitchTokenStore` implementation from your app (for example, your
current JSON-backed store):

```typescript
import { TwitchClient, type TwitchTokenStore } from 'streamops-twitch-connector';
import { twitchTokenStore } from './twitch-token-store.js';

const tokenStore: TwitchTokenStore = twitchTokenStore;

export const twitch = new TwitchClient({
  clientId: process.env.TWITCH_CLIENT_ID!,
  clientSecret: process.env.TWITCH_CLIENT_SECRET!,
  scopes: ['user:read:chat', 'user:write:chat'],
  tokenStore,
});
```

`TwitchTokenStore` has three methods: `load()` returns saved tokens or `null`,
`save(tokens)` persists the complete token set, and `clear()` removes it.
Persist every `save()` call because Twitch can rotate the refresh token.
Protect the file or database with appropriate server-side access controls.

## Choose an authorization flow

Use Device Code Grant for clients that cannot safely keep a client secret. It
preserves the original `0.3.0` login API:

```typescript
const login = await twitch.tokens.startLogin();
console.log('Open:', login.verificationUri);
console.log('Enter code:', login.userCode);

const tokens = await twitch.tokens.completeLogin();
```

DCF refresh behavior depends on Twitch's token policy. If the refresh token
is rejected, the user will need to authorize again.

Use Authorization Code Grant when your product has a trusted backend. The
backend must keep its app's client secret private. It creates an authorization
URL and associates the returned `state` with the user's server-side session.
Redirect the user's browser to the URL:

```typescript
const callbackUri = 'https://your-product.example/api/twitch/callback';
const request = twitch.tokens.createAuthorizationRequest(callbackUri);

await session.set('twitchOAuthState', request.state);
return redirect(request.authorizationUrl);
```

The callback route receives `code` and `state` from Twitch. Retrieve the
expected state from that same user's session and pass both values to the
connector. The connector checks the state before exchanging the code and
saving the tokens:

```typescript
const expectedState = await session.get('twitchOAuthState');
const tokens = await twitch.tokens.completeAuthorization({
  code: callbackQuery.code,
  state: callbackQuery.state,
  expectedState,
  redirectUri: callbackUri,
});

await session.delete('twitchOAuthState');
```

Use the exact same registered `redirectUri` when creating the URL and
exchanging the code. Handle Twitch's `error` callback parameters in the
product's callback route and show an appropriate message to the user.
Keep the client secret on the backend; Authorization Code Grant requires it
for this confidential-server setup.

After authorization, normal API calls use the saved tokens:

```typescript
const user = await twitch.api.get('/users');
```

The connector validates tokens, refreshes them after expiry or an API `401`,
and persists the new access and refresh tokens. If Twitch rejects a refresh
token, listen for `reauthentication_required` and send the user through the
connect flow again:

```typescript
twitch.tokens.onAuthError((error) => {
  if ('errorCode' in error && error.errorCode === 'reauthentication_required') {
    // Notify the product that this user must connect Twitch again.
  }
});
```

## Receive and send chat messages

After connecting EventSub, subscribe to chat messages. The callback receives
a plain typed message object; log it, map it to your own model, or publish it
to another part of your app:

```typescript
twitch.chat.onMessage((message) => {
  console.log(`${message.chatterName}: ${message.text}`);

  const productMessage = {
    user: message.chatterName,
    text: message.text,
    receivedAt: message.sentAt,
  };
  // Pass productMessage to your own event bus or application logic.
});

twitch.eventSub.onSession(async (sessionId) => {
  await twitch.subscriptions.subscribeToChatMessages(
    broadcasterUserId,
    userId,
    sessionId,
  );
});

await twitch.connectEventSub();
```

Send a chat message with:

```typescript
await twitch.chat.sendMessage({
  broadcasterId,
  message: 'Hello from my app!',
});
```

## Design and limitations

- No NestJS, Express, or other framework dependency. Products implement their
  own routes, session/state storage, and token storage.
- Each product registers its own Twitch application and configures its own
  Client ID, scopes, and token store. ACF additionally requires a private
  client secret and registered redirect URI.
- The connector currently supports one authenticated Twitch account per
  `TwitchClient` / token store. Products supporting multiple Twitch users
  should create isolated clients and token stores per account.
- Tokens are checked with Twitch periodically and refreshed as needed. Helix
  `401` responses trigger one refresh-and-retry attempt.
- Call `twitch.tokens.dispose()` when the client is no longer needed to stop
  background token checks.
- Chat messages are received through EventSub and sent through Helix.

Treat access and refresh tokens as sensitive. Do not commit them to source
control.

The original Device Code `startLogin()` / `completeLogin()` API remains
available for existing products. ACF is opt-in through
`createAuthorizationRequest()` / `completeAuthorization()`.
