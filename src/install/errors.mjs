// Shared error type for every host installer. Codes are stable contract: the
// CLI prints them verbatim and the tests assert on them.
export class InstallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
