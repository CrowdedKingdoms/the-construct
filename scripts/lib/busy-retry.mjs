/**
 * Retries a game API request the API answered "The service is busy" (a database connection
 * not free in time), with a growing pause. Anything else, and the last attempt, throws.
 */
export async function whenNotBusy(fn, { tries = 5, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!/service is busy/i.test(String(error?.message ?? error)) || attempt >= tries)
        throw error;
      onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
}
