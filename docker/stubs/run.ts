// Runs the provider stubs (OpenAI and WaveSpeed shapes) as a server for the local and CI stacks.
// The stub binds loopback on a random port, so a TCP forward publishes it on STUB_PORT.
// Run with: node docker/stubs/run.ts   (Node 24 strips the types itself)
import { createServer, connect } from 'node:net';
import { startStubServer } from '../../tools/provider-stubs/src/stub-server.ts';

const port = Number(process.env['STUB_PORT'] ?? 8089);
const stub = await startStubServer();
const forward = createServer((client) => {
  const upstream = connect(stub.port, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  const drop = () => { client.destroy(); upstream.destroy(); };
  client.on('error', drop);
  upstream.on('error', drop);
});
forward.listen(port, '0.0.0.0', () => {
  console.log(`provider stubs on :${port}; openai key ${stub.openAiKey}, wavespeed key ${stub.waveSpeedKey}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    forward.close();
    void stub.close().then(() => process.exit(0));
  });
}
