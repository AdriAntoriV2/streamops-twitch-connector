
import { describe, expect, it, vi } from 'vitest';
import { TwitchChatClient } from '../src/chat/twitch-chat-client.js';
import type { TwitchApiClient } from '../src/api/twitch-api-client.js';

describe('TwitchChatClient', () => {
  it('converts EventSub chat payloads into chat messages', async () => {
    const api = {
      post: vi.fn(),
    } as unknown as TwitchApiClient;

    const client = new TwitchChatClient(api);
    const handler = vi.fn();

    client.onMessage(handler);

    await client.handleEventSubMessage({
      message_id: 'message-123',
      broadcaster_user_id: 'broadcaster-1',
      chatter_user_id: 'viewer-1',
      chatter_user_name: 'TestViewer',
      message: {
        text: 'Hello StreamOps!',
      },
      message_timestamp: '2026-10-18T10:00:00Z',
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      messageId: 'message-123',
      broadcasterId: 'broadcaster-1',
      chatterId: 'viewer-1',
      chatterName: 'TestViewer',
      text: 'Hello StreamOps!',
      sentAt: '2026-10-18T10:00:00Z',
      raw: expect.objectContaining({
        message_id: 'message-123',
      }),
    });

    expect(api.post).not.toHaveBeenCalled();
  });

  it('ignores incomplete chat payloads', async () => {
    const api = {
      post: vi.fn(),
    } as unknown as TwitchApiClient;

    const client = new TwitchChatClient(api);
    const handler = vi.fn();

    client.onMessage(handler);

    await client.handleEventSubMessage({
      message_id: 'message-123',
      message: { text: 'Missing broadcaster and chatter IDs' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('sends a chat message through Helix', async () => {
    const api = {
      post: vi.fn().mockResolvedValue({
        data: [
          {
            message_id: 'sent-123',
            is_sent: true,
            drop_reason: null,
          },
        ],
      }),
    } as unknown as TwitchApiClient;

    const client = new TwitchChatClient(api);

    const result = await client.sendMessage({
      broadcasterId: 'broadcaster-1',
      message: 'Test message',
    });

    expect(api.post).toHaveBeenCalledWith('/chat/messages', {
      broadcaster_id: 'broadcaster-1',
      sender_id: 'broadcaster-1',
      message: 'Test message',
    });

    expect(result.isSent).toBe(true);
    expect(result.messageId).toBe('sent-123');
  });
});
