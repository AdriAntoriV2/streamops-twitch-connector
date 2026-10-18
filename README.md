# streamops-twitch-connector

# StreamOps Twitch Connector

A framework-independent TypeScript connector for Twitch OAuth, Helix API
requests, chat messaging, and EventSub WebSocket notifications.

## Requirements

- Node.js 22 or newer
- A Twitch application with a registered Client ID
- A token store implementation supplied by the consuming application

## Install dependencies

```text
npm install
```

## Build

```text
npm run build
```

## Basic usage

```typescript
import {
  TwitchClient,
  type TwitchTokenStore,
  type TwitchTokens,
} from 'streamops-twitch-connector';

const tokenStore: TwitchTokenStore = {
  async load(): Promise<TwitchTokens | null> {
    // Load tokens from your preferred secure storage.
    return null;
  },

  async save(tokens: TwitchTokens): Promise<void> {
    // Persist tokens securely.
  },

  async clear(): Promise<void> {
    // Remove persisted tokens.
  },
};

const twitch = new TwitchClient({
  clientId: process.env.TWITCH_CLIENT_ID!,
  scopes: ['user:read:chat', 'user:write:chat'],
  tokenStore,
});

const login = await twitch.tokens.startLogin();

console.log('Open:', login.verificationUri);
console.log('Enter code:', login.userCode);

// Call completeLogin() after starting the login flow.
// The method polls until authorization succeeds or fails.
await twitch.tokens.completeLogin();

twitch.chat.onMessage(async (message) => {
  console.log(`${message.chatterName}: ${message.text}`);
});

await twitch.connectEventSub();

// After receiving the EventSub session welcome, subscribe using
// twitch.eventSub.currentSessionId and twitch.subscriptions.
```

## Design

- No dependency on NestJS or Express.
- OAuth tokens are persisted through a caller-provided token store.
- Helix requests automatically include the Client ID and access token.
- Chat messages are received through EventSub and sent through Helix.
- EventSub subscriptions use the active WebSocket session ID.

## Notes

The initial implementation assumes one authenticated Twitch account.
A separate bot account and multi-account token management are not included.

Treat token storage as sensitive. Do not commit access tokens or refresh
tokens to source control.
