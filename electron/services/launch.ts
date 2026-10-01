import { spawn } from 'node:child_process';
import { UserError } from './errors';
import { exists, safeDestination } from './files';

export async function launchModdedMac(gameRoot: string): Promise<void> {
  const library = await safeDestination(gameRoot, 'liblovely.dylib');
  const executable = await safeDestination(gameRoot, 'Balatro.app/Contents/MacOS/love');
  if (!(await exists(library)))
    throw new UserError(
      'Lovely’s macOS library is missing. Follow the official installation instructions.',
    );
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const failure = (details: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        new UserError(
          'macOS could not start modded Balatro. Check that Lovely matches your Mac’s architecture and follow its official installation instructions. If macOS blocks the component, review the operating system’s prompt.',
          undefined,
          details,
        ),
      );
    };
    const child = spawn(executable, [], {
      cwd: gameRoot,
      env: { ...process.env, DYLD_INSERT_LIBRARIES: library },
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (error) => failure(String(error)));
    child.once('exit', (code, signal) =>
      failure(`The game exited during startup (code ${code}, signal ${signal}).`),
    );
    child.once('spawn', () => {
      // Creating a process alone does not prove that dyld accepted Lovely.
      timer = setTimeout(() => {
        finished = true;
        child.unref();
        resolve();
      }, 1500);
    });
  });
}
