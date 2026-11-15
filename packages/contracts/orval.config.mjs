// Generates Zod 4 schemas and the TanStack Query client from openapi.yaml. Output is never hand-edited.
export default {
  zod: {
    input: './openapi.yaml',
    output: {
      mode: 'single',
      target: './src/generated/zod.ts',
      client: 'zod',
      override: { zod: { coerce: { query: true } } },
    },
  },
  client: {
    input: './openapi.yaml',
    output: {
      mode: 'single',
      target: './src/generated/client.ts',
      client: 'react-query',
      httpClient: 'fetch',
      override: { query: { version: 5 }, mutator: { path: './src/http.ts', name: 'httpClient' } },
    },
  },
};
