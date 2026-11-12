import type { AsyncEntry } from '@napi-rs/keyring';
import type { TwitchTokenStore, TwitchTokens } from './token-store.js';

export class KeyringTokenStore implements TwitchTokenStore {
  private readonly entry: Promise<AsyncEntry>;

  constructor(service: string, account: string) {
    if (!service || !account) {
      throw new Error('A keyring service and account name are required.');
    }

    const options =
      process.platform === 'linux'
        ? { linux: { store: 'secret-service' as const } }
        : undefined;

    this.entry = import('@napi-rs/keyring').then(
      ({ AsyncEntry }) => new AsyncEntry(service, account, options),
    );
  }

  async load(): Promise<TwitchTokens | null> {
    const savedTokens = await (await this.entry).getPassword();

    if (savedTokens === null) {
      return null;
    }

    const tokens: unknown = JSON.parse(savedTokens);

    if (!isTwitchTokens(tokens)) {
      throw new Error('The saved Twitch tokens in the system keyring are invalid.');
    }

    return tokens;
  }

  async save(tokens: TwitchTokens): Promise<void> {
    await (await this.entry).setPassword(JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    await (await this.entry).deletePassword();
  }
}

function isTwitchTokens(value: unknown): value is TwitchTokens {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const tokens = value as Partial<TwitchTokens>;

  return (
    typeof tokens.accessToken === 'string' &&
    typeof tokens.refreshToken === 'string' &&
    typeof tokens.expiresAt === 'number' &&
    Number.isFinite(tokens.expiresAt) &&
    Array.isArray(tokens.scopes) &&
    tokens.scopes.every((scope) => typeof scope === 'string')
  );
}
