import {
  KeyringTokenStore,
  TwitchClient,
} from 'streamops-twitch-connector';
import {
  KEYRING_ACCOUNT,
  KEYRING_SERVICE,
  TWITCH_CLIENT_ID,
  TWITCH_SCOPES,
} from '../config.js';

const tokenStore = new KeyringTokenStore(
  KEYRING_SERVICE,
  KEYRING_ACCOUNT,
);

const twitch = new TwitchClient({
  clientId: TWITCH_CLIENT_ID,
  scopes: TWITCH_SCOPES,
  tokenStore,
});

twitch.tokens.onAuthError((error) => {
  if ('errorCode' in error && error.errorCode === 'reauthentication_required') {
    console.error('Twitch login expired or was revoked. Connect again.');
    return;
  }

  console.error('Twitch token refresh failed; the connector will retry:', error);
});

async function main(): Promise<void> {
  const savedTokens = await tokenStore.load();

  if (!savedTokens) {
    const login = await twitch.tokens.startLogin();

    console.log(`Open this page: ${login.verificationUri}`);
    console.log(`Enter this code: ${login.userCode}`);
    console.log('Waiting for you to approve access in your browser...');

    await twitch.tokens.completeLogin();
    console.log('Twitch account connected.');
  } else {
    console.log('Using the saved Twitch login.');
  }

  const response = await twitch.api.get<{
    data: Array<{ login: string; display_name: string }>;
  }>('/users');
  const user = response.data[0];

  if (!user) {
    throw new Error('Twitch did not return the connected account.');
  }

  console.log(`Connected as ${user.display_name} (@${user.login}).`);
}

void main()
  .catch((error: unknown) => {
    console.error('Could not connect to Twitch:', error);
    process.exitCode = 1;
  })
  .finally(() => twitch.tokens.dispose());
