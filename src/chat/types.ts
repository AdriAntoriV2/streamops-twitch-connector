
export interface TwitchChatMessage {
  messageId: string;
  broadcasterId: string;
  chatterId: string;
  chatterName: string;
  text: string;
  sentAt: string;
  raw: unknown;
}

export interface SendChatMessageOptions {
  broadcasterId: string;
  senderId?: string;
  message: string;
}

export interface SendChatMessageResult {
  messageId?: string;
  isSent: boolean;
  dropReason?: string;
  raw: unknown;
}

export type TwitchChatMessageHandler = (
  message: TwitchChatMessage,
) => void | Promise<void>;
