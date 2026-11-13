
import type {
  EventSubConnectionState,
  EventSubEnvelope,
  EventSubNotificationHandler,
} from './types.js';
import { TwitchError } from '../errors/twitch-error.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type EventSubSessionHandler = (
  sessionId: string,
  isReconnectHandover: boolean,
) => Promise<void> | void;

export type EventSubErrorHandler = (error: Error) => void;

export class EventSubClient {
  private socket: WebSocket | null = null;
  private reconnectUrl: string | null = null;
  private sessionId: string | null = null;
  private keepaliveTimeoutSeconds = 10;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private state: EventSubConnectionState = 'disconnected';

  private readonly handlers = new Set<EventSubNotificationHandler>();
  private readonly sessionHandlers = new Set<EventSubSessionHandler>();
  private readonly errorHandlers = new Set<EventSubErrorHandler>();

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

  onSession(handler: EventSubSessionHandler): () => void {
    this.sessionHandlers.add(handler);
    return () => this.sessionHandlers.delete(handler);
  }

  onError(handler: EventSubErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
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

  private openSocket(
    url: string,
    isReconnectHandover = false,
  ): void {
    let socket: WebSocket;

    try {
      socket = new WebSocket(url);
    } catch (error) {
      // Logging suppressed.
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
    let socketErrorReported = false;

    // Logging suppressed; retain original connection behavior.
    void previousSocket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }

      this.setState('connected');
    });

    socket.addEventListener('message', (message: MessageEvent) => {
      if (this.socket !== socket) {
        return;
      }

      const raw = String(message.data);

      void this.handleMessage(raw, isReconnectHandover).catch(
        (error: unknown) => {
          this.reportError(error);
        },
      );
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) {
        return;
      }

      socketErrorReported = true;
      this.reportError(
        new TwitchError('Twitch EventSub WebSocket encountered a connection error.'),
      );
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.clearKeepaliveTimer();

      if (!this.intentionalClose) {
        if (!socketErrorReported) {
          this.reportError(
            new TwitchError(
              `Twitch EventSub WebSocket closed unexpectedly (code: ${event.code}${
                event.reason ? `, reason: ${event.reason}` : ''
              }).`,
            ),
          );
        }
        this.setState('reconnecting');
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    });
  }

  private async handleMessage(
    raw: string,
    isReconnectHandover: boolean,
  ): Promise<void> {
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

        for (const handler of this.sessionHandlers) {
          try {
            await handler(session.id, isReconnectHandover);
          } catch (error) {
            this.reportError(error);
            this.reconnectAfterSessionError();
            return;
          }
        }

        this.reconnectAttempts = 0;
        break;
      }

      case 'session_keepalive':
        this.resetKeepaliveTimer();
        break;

      case 'session_reconnect': {
        const reconnectUrl = envelope.payload.session?.reconnect_url;

        if (!reconnectUrl) {
          this.reportError(
            new TwitchError(
              'Twitch EventSub reconnect message did not include a reconnect URL.',
            ),
          );
          return;
        }

        this.reconnectUrl = reconnectUrl;
        this.clearKeepaliveTimer();

        // Preserve original session handover behavior.
        this.openSocket(reconnectUrl, true);
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
        this.reportError(
          new TwitchError('Twitch EventSub session handover failed.'),
        );
        this.reconnectUrl = null;
        this.scheduleReconnect();
        break;

      case 'revocation':
        this.reportError(
          new TwitchError(
            `Twitch revoked the EventSub subscription${
              envelope.payload.subscription?.type
                ? ` "${envelope.payload.subscription.type}"`
                : ''
            } (status: ${
              envelope.payload.subscription?.status ?? 'unknown'
            }).`,
          ),
        );
        break;

      default:
        // Unknown message logging suppressed.
        break;
    }
  }

  private resetKeepaliveTimer(): void {
    this.clearKeepaliveTimer();

    const bufferSeconds = 5;
    const timeoutMs = (this.keepaliveTimeoutSeconds + bufferSeconds) * 1000;

    this.keepaliveTimer = setTimeout(() => {
      const socket = this.socket;
      this.socket = null;
      this.reportError(
        new TwitchError(
          `Twitch EventSub did not receive a keepalive or notification within ${this.keepaliveTimeoutSeconds + bufferSeconds} seconds (configured timeout: ${this.keepaliveTimeoutSeconds}s + ${bufferSeconds}s buffer).`,
        ),
      );

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }, timeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) {
      return;
    }

    this.setState('reconnecting');

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.sessionId = null;

      if (!this.intentionalClose) {
        try {
          this.openSocket(this.reconnectUrl ?? EVENTSUB_URL);
        } catch (error) {
          this.reportError(error);
        }
      }
    }, delay);
  }

  private reconnectAfterSessionError(): void {
    const socket = this.socket;
    if (!socket || this.intentionalClose) {
      return;
    }

    this.socket = null;
    this.clearKeepaliveTimer();
    socket.close();
    this.scheduleReconnect();
  }

  private reportError(error: unknown): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));

    if (this.errorHandlers.size === 0) {
      console.error('[EventSub] Error:', normalizedError);
      return;
    }

    for (const handler of this.errorHandlers) {
      try {
        handler(normalizedError);
      } catch (handlerError) {
        console.error('[EventSub] Error handler failed:', handlerError);
      }
    }
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
