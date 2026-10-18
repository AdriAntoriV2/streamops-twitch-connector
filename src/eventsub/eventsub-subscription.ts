
import type { TwitchApiClient } from '../api/twitch-api-client.js';
import { TwitchError } from '../errors/twitch-error.js';

interface CreateSubscriptionResponse {
  data?: Array<{
    id: string;
    status: string;
    type: string;
  }>;
  error?: string;
  message?: string;
  status?: number;
}

export class EventSubSubscriptions {
  constructor(private readonly api: TwitchApiClient) {}

  async subscribe(
    type: string,
    version: string,
    condition: Record<string, string>,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    if (!sessionId) {
      throw new TwitchError(
        'An active EventSub WebSocket session ID is required.',
      );
    }

    return this.api.post<CreateSubscriptionResponse>(
      '/eventsub/subscriptions',
      {
        type,
        version,
        condition,
        transport: {
          method: 'websocket',
          session_id: sessionId,
        },
      },
    );
  }

  async subscribeToChatMessages(
    broadcasterUserId: string,
    userId: string,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    return this.subscribe(
      'channel.chat.message',
      '1',
      {
        broadcaster_user_id: broadcasterUserId,
        user_id: userId,
      },
      sessionId,
    );
  }

  async subscribeToStreamOnline(
    broadcasterUserId: string,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    return this.subscribe(
      'stream.online',
      '1',
      { broadcaster_user_id: broadcasterUserId },
      sessionId,
    );
  }

  async subscribeToStreamOffline(
    broadcasterUserId: string,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    return this.subscribe(
      'stream.offline',
      '1',
      { broadcaster_user_id: broadcasterUserId },
      sessionId,
    );
  }

  async subscribeToFollows(
    broadcasterUserId: string,
    moderatorUserId: string,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    return this.subscribe(
      'channel.follow',
      '2',
      {
        broadcaster_user_id: broadcasterUserId,
        moderator_user_id: moderatorUserId,
      },
      sessionId,
    );
  }

  async subscribeToChannelPointRedemptions(
    broadcasterUserId: string,
    sessionId: string,
  ): Promise<CreateSubscriptionResponse> {
    return this.subscribe(
      'channel.channel_points_custom_reward_redemption.add',
      '1',
      { broadcaster_user_id: broadcasterUserId },
      sessionId,
    );
  }
}
