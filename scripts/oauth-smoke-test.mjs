
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TwitchClient } from '../dist/index.js';

const clientId = process.env.TWITCH_CLIENT_ID;

if (!clientId) {
  console.error('Missing TWITCH_CLIENT_ID environment variable.');
  process.exit(1);
}

const scopes = ['user:read:chat', 'user:write:chat'];

const tokenStore = {
  tokens: null,

  async load() {
    return this.tokens;
  },

  async save(tokens) {
    this.tokens = tokens;
  },

  async clear() {
    this.tokens = null;
  },
};

const client = new TwitchClient({
  clientId,
  scopes,
  tokenStore,
});

const rl = createInterface({ input: stdin, output: stdout });

try {
  const login = await client.tokens.startLogin();

  console.log('\nOpen this URL in your browser:');
  console.log(login.verificationUri);
  console.log('\nEnter this code when prompted:');
  console.log(login.userCode);
  console.log(`\nThe code expires in ${Math.floor(login.expiresIn / 60)} minutes.`);

  console.log('\nWaiting for Twitch authorization...');

  await client.tokens.completeLogin();

  console.log('Authorization received. Validating token...');

  const validated = await client.tokens.getValidatedToken();

  console.log('\nOAuth test passed!');
  console.log(`Twitch login: ${validated.login}`);
  console.log(`Twitch user ID: ${validated.user_id}`);
  console.log(`Granted scopes: ${validated.scopes.join(', ')}`);
  console.log(`Token expires in: ${validated.expires_in} seconds`);
} catch (error) {
  console.error('\nOAuth test failed:', error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
