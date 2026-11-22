/** Any failure talking to the EcoFlow app API (network, HTTP status, bad JSON, non-success reply). */
export class EcoflowApiError extends Error {
  constructor(
    message: string,
    /** EcoFlow's own `code` from the JSON reply, when the server sent one. */
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EcoflowApiError';
  }
}

/**
 * The server rejected the credentials (login answered with an error code).
 * Retrying with the same email and password will not help.
 */
export class EcoflowAuthError extends EcoflowApiError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'EcoflowAuthError';
  }
}
