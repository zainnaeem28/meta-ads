import { startStack, type Stack } from './stack';

let stack: Stack | undefined;

/** Starts the api, worker, database, object storage and provider stub; the workers read their addresses from the environment. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const api = Number(process.env.E2E_API_PORT ?? 4104);
  const web = Number(process.env.WEB_PORT ?? 3104);
  stack = await startStack({ api, web, control: Number(process.env.E2E_CONTROL_PORT ?? 4105) });
  process.env.FLOW01_API_URL = stack.apiUrl;
  process.env.FLOW01_CONTROL_URL = stack.controlUrl;
  return async () => {
    await stack?.stop();
  };
}
