
import type { TwitchConnectorConfig } from '../api/types.js';
import { TwitchApiClient } from '../api/twitch-api-client.js';
import { DeviceCodeFlow } from '../auth/device-code-flow.js';
import { TokenManager } from '../auth/token-manager.js';
import type { TwitchTokenStore } from '../auth/token-store.js';
import { TwitchChatClient } from '../chat/twitch-chat-client.js';
import { EventSubClient } from '../eventsub/eventsub-client.js';
import { EventSubSubscriptions } from '../eventsub/eventsub-subscription.js';

export class TwitchClient {
  readonly tokens: TokenManager;
  readonly api: TwitchApiClient;
  readonly chat: TwitchChatClient;
  readonly eventSub: EventSubClient;
  readonly subscriptions: EventSubSubscriptions;

  constructor(config: TwitchConnectorConfig) {
    const tokenStore: TwitchTokenStore = config.tokenStore;

    const deviceCodeFlow = new DeviceCodeFlow({
      clientId: config.clientId,
      scopes: config.scopes,
      fetch: config.fetch,
    });

    this.tokens = new TokenManager(
      config,
      tokenStore,
      deviceCodeFlow,
    );

    this.api = new TwitchApiClient(config, this.tokens);
    this.chat = new TwitchChatClient(this.api);
    this.eventSub = new EventSubClient();
    this.subscriptions = new EventSubSubscriptions(this.api);

    this.eventSub.onNotification(async (type, event, envelope) => {
      if (type === 'channel.chat.message') {
        await this.chat.handleEventSubMessage(event);
      }

      // Other event types remain available to additional handlers
      // registered directly on eventSub.
      void envelope;
    });
  }

  async connectEventSub(): Promise<void> {
    await this.tokens.getAccessToken();
    await this.eventSub.connect();
  }

  async disconnectEventSub(): Promise<void> {
    await this.eventSub.disconnect();
  }
}
