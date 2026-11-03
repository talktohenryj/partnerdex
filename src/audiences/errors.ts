/** A request about an audience that cannot be served, with a message for the reader. */
export class AudienceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AudienceError';
  }
}
