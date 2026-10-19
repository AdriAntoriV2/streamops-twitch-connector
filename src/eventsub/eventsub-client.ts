
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
  ) { }

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
      this.scheduleReconnect();
      throw new TwitchError(
        'Unable to create Twitch EventSub WebSocket.',
        undefined,
        undefined,
        { cause: error },
      );
    }

    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket === socket) {
        this.setState('connected');
      }
    });

    socket.addEventListener('message', (message: MessageEvent) => {
      if (this.socket !== socket) {
        return;
      }

      void this.handleMessage(String(message.data)).catch((error) => {
        // Keep one malformed notification from crashing the process.
        console.error('[EventSub] Failed to process message:', error);
      });
    });

    socket.addEventListener('error', () => {
      // The close event is responsible for scheduling reconnection.
    });

    socket.addEventListener('close', () => {
      // A replaced socket must not affect the active connection.
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
        break;
      }

      case 'session_keepalive':
        this.resetKeepaliveTimer();
        break;

      case 'session_reconnect': {
        const reconnectUrl = envelope.payload.session?.reconnect_url;

        if (reconnectUrl) {
          this.reconnectUrl = reconnectUrl;
          this.clearKeepaliveTimer();
          // Twitch expects the existing socket to remain alive until
          // the replacement connection is established.
          this.openSocket(reconnectUrl);
        }
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
        this.reconnectUrl = null;
        this.scheduleReconnect();
        break;

      case 'revocation':
        console.warn('[EventSub] Subscription revoked:', envelope.payload);
        break;

      default:
        break;
    }
  }

  private resetKeepaliveTimer(): void {
    this.clearKeepaliveTimer();

    this.keepaliveTimer = setTimeout(() => {
      console.warn('[EventSub] Keepalive timeout; reconnecting.');

      const socket = this.socket;
      this.socket = null;

      if (socket) {
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
