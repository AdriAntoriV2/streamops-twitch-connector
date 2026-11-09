import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventSubClient } from '../src/eventsub/eventsub-client.js';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent | CloseEvent) => void>
  >();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent | CloseEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason } as CloseEvent);
  }

  emit(type: string, event: MessageEvent | CloseEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {} as MessageEvent);
  }

  sendMessage(message: object): void {
    this.emit('message', {
      data: JSON.stringify(message),
    } as MessageEvent);
  }
}

function envelope(messageType: string, payload: object) {
  return {
    metadata: { message_type: messageType },
    payload,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  MockWebSocket.instances = [];
});

describe('EventSubClient', () => {
  it('reports session handler failures and reconnects to retry setup', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);

    const client = new EventSubClient();
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    client.onSession(() => {
      throw new Error('Chat subscription failed');
    });

    await client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    firstSocket.sendMessage(
      envelope('session_welcome', {
        session: { id: 'session-1', keepalive_timeout_seconds: 10 },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Chat subscription failed');
    expect(client.connectionState).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    await client.disconnect();
  });

  it('reports subscription revocations to error listeners', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);

    const client = new EventSubClient();
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));

    await client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.sendMessage(
      envelope('revocation', {
        subscription: {
          type: 'channel.chat.message',
          status: 'authorization_revoked',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('channel.chat.message');
    expect(errors[0].message).toContain('authorization_revoked');

    await client.disconnect();
  });

  it('reports unexpected WebSocket closure details', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);

    const client = new EventSubClient();
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));

    await client.connect();
    MockWebSocket.instances[0].close(1006, 'network interruption');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('1006');
    expect(errors[0].message).toContain('network interruption');
    expect(client.connectionState).toBe('reconnecting');

    await client.disconnect();
  });
});
