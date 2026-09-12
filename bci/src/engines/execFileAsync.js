import { spawn } from 'node:child_process';

// Always argv-array, never `shell: true` -- a target string (attacker-
// reachable: it's the value a user asked BCI to scan) must never be
// concatenated into a shell command line.
//
// stdin is explicitly closed (`stdio: ['ignore', ...]`) rather than left as
// an open pipe: several of these CLIs (naabu, nuclei) block waiting to read
// additional targets from stdin when it's an open-but-empty pipe -- which is
// exactly what Node hands a child by default -- and never time out on their
// own. An interactive terminal doesn't have that problem because stdin
// there isn't an empty pipe; a spawned child's is.
export function runBinary(bin, args, { timeoutMs = 60_000, allowedExitCodes = [0], maxBufferBytes = 32 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const abort = () => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      clearTimeout(timer);
      const error = new Error(`${bin} cancelled`);
      error.name = 'AbortError';
      reject(error);
    };

    signal?.addEventListener('abort', abort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBufferBytes) stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBufferBytes) stderr = Buffer.concat([stderr, chunk]);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0 && !allowedExitCodes.includes(code)) {
        return reject(new Error(`${bin} exited ${code}: ${stderr.toString('utf8').slice(0, 2000)}`));
      }
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: code });
    });

    if (signal?.aborted) abort();
  });
}
