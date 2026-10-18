
export class TwitchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TwitchError';
  }
}
