/** The network or cluster definitively rejected a transaction (simulation/preflight failure, bad blockhash...). */
export class ChainRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainRejectedError';
  }
}
