export const TWITCH_CLIENT_ID = 'YOUR_TWITCH_CLIENT_ID';

// Only set this in a trusted backend environment. A public local app must
// leave it unset and use Device Code Grant.
export const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

export const TWITCH_SCOPES = ['user:read:chat', 'user:write:chat'];
export const KEYRING_SERVICE = 'YOUR_APP_NAME';
export const KEYRING_ACCOUNT = 'twitch-account';
