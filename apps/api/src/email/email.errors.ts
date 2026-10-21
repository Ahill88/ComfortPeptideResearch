/** A message that can never be sent as given (caller bug). The reason never contains the address or any data value. */
export class EmailValidationError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid email message: ${reason}`);
    this.name = 'EmailValidationError';
  }
}

/** Startup refused: the EMAIL_* environment is inconsistent. Messages name variables, never values. */
export class EmailConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid email configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EmailConfigError';
  }
}
