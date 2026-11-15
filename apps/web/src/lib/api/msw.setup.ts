import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

// Shared MSW server for every unit test. A request no handler covers errors (MSW 3 names the
// `onUnhandledRequest: 'error'` option `onUnhandledFrame`).
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
