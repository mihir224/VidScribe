type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  jitterMs: number;
  onRetry?: (attempt: number, error: unknown) => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt === options.attempts) {
        break;
      }

      options.onRetry?.(attempt, error);
      const exponentialDelay = options.baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * options.jitterMs);
      await delay(exponentialDelay + jitter);
    }
  }

  throw lastError;
}
