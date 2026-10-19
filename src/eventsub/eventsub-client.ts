
import type {
  EventSubConnectionState,
  EventSubEnvelope,
  EventSubNotificationHandler,
} from './types.js';
import { TwitchError } from '../errors/twitch-error.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

export class EventSubClient {
  private socket: WebSocket | null = null;
  private reconnectUrl: string | null = null;
  private sessionId: string | null = null;
  private keepaliveTimeoutSeconds = 10;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private state: EventSubConnectionState = 'disconnected';
  private readonly handlers = new Set<EventSubNotificationHandler>();

  constructor(
    private readonly onStateChange?: (
      state: EventSubConnectionState,
    ) => void,
  ) {}

  get connectionState(): EventSubConnectionState {
    return this.state;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  onNotification(handler: EventSubNotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.clearReconnectTimer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.setState('connecting');
    this.openSocket(this.reconnectUrl ?? EVENTSUB_URL);
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    this.reconnectUrl = null;
    this.sessionId = null;

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      socket.close(1000, 'Client disconnect');
    }

    this.setState('disconnected');
  }

  private openSocket(url: string): void {
    let socket: WebSocket;

    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.error('[EventSub] Failed to create WebSocket:', error);
      this.scheduleReconnect();

      throw new TwitchError(
        'Unable to create Twitch EventSub WebSocket.',
        undefined,
        undefined,
        { cause: error },
      );
    }

    const previousSocket = this.socket;
    this.socket = socket;

    // A replacement socket takes over ownership. Its predecessor must not
    // reset timers or trigger another reconnect when it eventually closes.
    if (
      previousSocket &&
      previousSocket !== socket &&
      previousSocket.readyState !== WebSocket.CLOSED
    ) {
      console.log('[EventSub] Replacing the previous WebSocket connection.');
    }

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }

      console.log('[EventSub] WebSocket connected.');
      this.setState('connected');
    });

    socket.addEventListener('message', (message: MessageEvent) => {
      if (this.socket !== socket) {
        return;
      }

      const raw = String(message.data);

      // Diagnostic logging: EventSub notifications can contain chat content.
      // Avoid logging their complete payload.
      try {
        const envelope = JSON.parse(raw) as EventSubEnvelope;
        const messageType = envelope.metadata?.message_type;

        console.log(
          `[EventSub] Received message type: ${messageType ?? 'unknown'}`,
        );
      } catch {
        console.warn('[EventSub] Received a non-JSON WebSocket message.');
      }

      void this.handleMessage(raw).catch((error: unknown) => {
        console.error('[EventSub] Failed to process message:', error);
      });
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        console.error('[EventSub] WebSocket error.');
      }
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      console.log(
        `[EventSub] Socket closed: code=${event.code}, reason=${event.reason || '(none)'}`,
      );

      // A stale socket must not affect the active connection.
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.clearKeepaliveTimer();

      if (!this.intentionalClose) {
        this.setState('reconnecting');
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as EventSubEnvelope;
    const messageType = envelope.metadata?.message_type;

    if (!messageType) {
      return;
    }

    switch (messageType) {
      case 'session_welcome': {
        const session = envelope.payload.session;

        if (!session?.id) {
          throw new TwitchError(
            'Twitch EventSub welcome message did not include a session ID.',
          );
        }

        this.sessionId = session.id;
        this.keepaliveTimeoutSeconds =
          session.keepalive_timeout_seconds ?? 10;
        this.reconnectUrl = null;
        this.resetKeepaliveTimer();

        console.log(
          `[EventSub] Session established. Keepalive timeout: ${this.keepaliveTimeoutSeconds}s.`,
        );
        break;
      }

      case 'session_keepalive':
        console.log('[EventSub] Keepalive received.');
        this.resetKeepaliveTimer();
        break;

      case 'session_reconnect': {
        const reconnectUrl = envelope.payload.session?.reconnect_url;

        if (!reconnectUrl) {
          console.warn(
            '[EventSub] Reconnect message did not contain a reconnect URL.',
          );
          return;
        }

        console.log('[EventSub] Twitch requested a session handover.');
        this.reconnectUrl = reconnectUrl;
        this.clearKeepaliveTimer();

        // Twitch expects the old socket to remain alive until the
        // replacement connection is established.
        this.openSocket(reconnectUrl);
        break;
      }

      case 'notification': {
        const subscriptionType =
          envelope.metadata.subscription_type ??
          envelope.payload.subscription?.type;

        if (!subscriptionType) {
          return;
        }

        for (const handler of this.handlers) {
          await handler(
            subscriptionType,
            envelope.payload.event,
            envelope,
          );
        }

        this.resetKeepaliveTimer();
        break;
      }

      case 'session_reconnect_failed':
        console.warn('[EventSub] Twitch reported that session handover failed.');
        this.reconnectUrl = null;
        this.scheduleReconnect();
        break;

      case 'revocation':
        console.warn('[EventSub] Subscription revoked:', envelope.payload);
        break;

      default:
        console.log(`[EventSub] Unhandled message type: ${messageType}`);
        break;
    }
  }

  private resetKeepaliveTimer(): void {
    this.clearKeepaliveTimer();

    this.keepaliveTimer = setTimeout(() => {
      console.warn(
        `[EventSub] No keepalive or notification received within ${this.keepaliveTimeoutSeconds}s.`,
      );

      const socket = this.socket;
      this.socket = null;

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }, this.keepaliveTimeoutSeconds * 1000);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) {
      return;
    }

    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.sessionId = null;

      if (!this.intentionalClose) {
        this.openSocket(this.reconnectUrl ?? EVENTSUB_URL);
      }
    }, 2_000);
  }

  private setState(state: EventSubConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearKeepaliveTimer();
    this.clearReconnectTimer();
  }
}
