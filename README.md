# StreamOps Twitch Connector

Git URL : https://github.com/AdriAntoriV2/streamops-twitch-connector

A framework-independent TypeScript library for Twitch OAuth, Helix, chat, and
EventSub. For a public local app, use Device Code Grant: your app supplies its
Client ID, and each user connects their own Twitch account.

## Requirements

- Node.js 22 or newer
- A Twitch application
- A token store supplied by your app (the examples use the operating system
  credential store)

Never put a Twitch client secret or refresh token in a browser or desktop
client. Have those clients call your backend instead.

## How to use

1. Register one Twitch application for your product. Your users do not need to
   register their own applications.
2. Set your app's Client ID, requested scopes, and a unique keyring service
   name in [example/config.ts](https://github.com/AdriAntoriV2/streamops-twitch-connector/blob/main/example/config.ts). The Client ID is public
   and can be included in your app.
3. Use Device Code Grant for a public local app. Do not include a Client Secret
   in its release.
4. Install `streamops-twitch-connector` and run the Device Code example with
   your TypeScript runner.

The Authorization Code example is for a trusted backend only. Provide
`TWITCH_CLIENT_SECRET` through the backend environment (for example,
`node --env-file=.env ...`) and never bundle it in a local app.

Installing the library does not ask for credentials. Your app passes its
Client ID when it creates `TwitchClient`; `clientSecret` is optional and is
only needed for Authorization Code Grant on a trusted backend.

### Device Code Grant

Use this flow for a public local app because it does not need a Client Secret.
The first time it runs, there are no saved tokens, so it prints a URL and code
and waits for the user to approve access. The example then stores the tokens in
the operating system credential store. On later runs, it loads the saved
tokens automatically.

[Device Code Grant example](https://github.com/AdriAntoriV2/streamops-twitch-connector/blob/main/example/DeviceFlow/device-code-grant.ts)

### Authorization Code Grant

Use this flow in a trusted backend that can keep the Client Secret private. The
example starts a small local server. Register
`http://localhost:3000/callback` as the Twitch application's redirect URL, then
open `http://localhost:3000/login`.

[Authorization Code Grant example](https://github.com/AdriAntoriV2/streamops-twitch-connector/blob/main/example/AuthorizationFlow/authorization-code-grant.ts)

The local example keeps OAuth state in memory and is for one user. In a
multi-user app, keep each login's state in that user's server-side session.
Use the exact same redirect URL when creating the authorization request and
exchanging the returned code.

## After login

Both examples use `TwitchTokenStore`, which has three methods:

- `load()` returns saved tokens or `null`.
- `save(tokens)` persists the complete token set.
- `clear()` removes saved tokens.

Persist every `save()` call because Twitch can rotate refresh tokens. The
examples use `KeyringTokenStore` to save credentials in the operating system
credential store. On Linux, a persistent Secret Service provider (such as
GNOME Keyring or KWallet) must be available; the example reports an error if
it is not. The `TwitchTokenStore` interface also lets your app provide another
secure storage implementation.

The connector schedules refreshes shortly before the access token expires,
including immediately after a successful login. Device Code Grant refresh
tokens are single-use: Twitch returns a replacement refresh token each time,
and the token store must persist it. Twitch documents that an inactive Device
Code refresh token expires after 30 days; after that, the user must authorize
again.

The connector also retries a Helix request once after a `401`. If Twitch
rejects a refresh token, the user must connect again. Call
`twitch.tokens.dispose()` when your `TwitchClient` is no longer needed.

After connecting, use `twitch.api` for Helix requests, `twitch.chat` to send or
receive chat messages, and `twitch.eventSub` / `twitch.subscriptions` for
EventSub. See the TypeScript types exported by the package for each API.

## Design and limitations

- No NestJS, Express, or other framework dependency. Your app owns its routes
  and session/state storage.
- Register a separate Twitch application and configure its own Client ID,
  scopes, token store, and (for Authorization Code Grant) private Client
  Secret.
- One `TwitchClient` and token store support one authenticated Twitch account.
  For multiple accounts, create an isolated client and token store per account.
- The original Device Code `startLogin()` / `completeLogin()` API remains
  available. Authorization Code Grant is opt-in through
  `createAuthorizationRequest()` / `completeAuthorization()`.
