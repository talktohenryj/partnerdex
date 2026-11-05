/** A request about email that cannot be served, with a message for the reader. */
export class EmailError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** The field a 422 is about, so the form can mark it. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}
