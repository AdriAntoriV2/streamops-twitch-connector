
import type { TwitchApiClient } from '../api/twitch-api-client.js';
import type {
  SendChatMessageOptions,
  SendChatMessageResult,
  TwitchChatMessage,
  TwitchChatMessageHandler,
} from './types.js';
import { TwitchError } from '../errors/twitch-error.js';

interface HelixSendChatResponse {
  data?: Array<{
    message_id?: string;
    is_sent: boolean;
    drop_reason?: {
      code?: string;
      message?: string;
    } | null;
  }>;
}

interface EventSubChatMessage {
  message_id?: string;
  broadcaster_user_id?: string;
  chatter_user_id?: string;
  chatter_user_name?: string;
  message?: {
    text?: string;
  };
  message_timestamp?: string;
}

export class TwitchChatClient {
  private readonly handlers = new Set<TwitchChatMessageHandler>();

  constructor(private readonly api: TwitchApiClient) {}

  onMessage(handler: TwitchChatMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async handleEventSubMessage(payload: unknown): Promise<void> {
    const event = payload as EventSubChatMessage;

    if (
      !event.message_id ||
      !event.broadcaster_user_id ||
      !event.chatter_user_id
    ) {
      return;
    }

    const message: TwitchChatMessage = {
      messageId: event.message_id,
      broadcasterId: event.broadcaster_user_id,
      chatterId: event.chatter_user_id,
      chatterName: event.chatter_user_name ?? '',
      text: event.message?.text ?? '',
      sentAt: event.message_timestamp ?? new Date().toISOString(),
      raw: payload,
    };

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  async sendMessage(
    options: SendChatMessageOptions,
  ): Promise<SendChatMessageResult> {
    const senderId = options.senderId ?? options.broadcasterId;

    if (!options.message.trim()) {
      throw new TwitchError('Chat message cannot be empty.');
    }

    const response = await this.api.post<HelixSendChatResponse>(
      '/chat/messages',
      {
        broadcaster_id: options.broadcasterId,
        sender_id: senderId,
        message: options.message,
      },
    );

    const result = response.data?.[0];

    if (!result) {
      throw new TwitchError('Twitch returned no chat-send result.');
    }

    return {
      messageId: result.message_id,
      isSent: result.is_sent,
      dropReason: result.drop_reason?.message ?? result.drop_reason?.code,
      raw: response,
    };
  }
}
