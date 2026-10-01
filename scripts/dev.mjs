import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
await import('./build-electron.mjs');
const server = await createServer();
await server.listen();
const electronEnv = { ...process.env, MODATRO_DEV_URL: 'http://127.0.0.1:5173' };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: electronEnv,
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
