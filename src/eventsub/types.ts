
export interface EventSubWelcomeMessage {
  session: {
    id: string;
    status: string;
    keepalive_timeout_seconds?: number;
    reconnect_url?: string | null;
  };
}

export interface EventSubNotificationMessage {
  subscription: {
    id: string;
    type: string;
    version: string;
    status: string;
    condition: Record<string, string>;
    transport: {
      method: string;
      session_id?: string;
    };
    created_at: string;
  };
  event: unknown;
}

export interface EventSubEnvelope {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: {
    session?: EventSubWelcomeMessage['session'];
    subscription?: EventSubNotificationMessage['subscription'];
    event?: unknown;
    message?: {
      id?: string;
      type?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export type EventSubNotificationHandler = (
  subscriptionType: string,
  event: unknown,
  envelope: EventSubEnvelope,
) => void | Promise<void>;

export type EventSubConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';
