import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const QUANTUM_SCRIPTS_DIR = path.join(__dirname, '..', '..', 'quantum');

const PYTHON_BIN = process.env.BCI_PYTHON_BIN || 'python3';

// Every script this bridge is allowed to run, named explicitly rather than
// accepting any path under QUANTUM_SCRIPTS_DIR. No caller today passes a
// non-literal scriptName, but this makes "only these two scripts, ever"
// an enforced invariant rather than something that merely happens to be
// true of today's call sites -- a future caller bug (e.g. building
// scriptName from a request field) can't turn this into arbitrary script
// execution.
const ALLOWED_SCRIPTS = new Set(['optimize_knapsack_qaoa.py', 'ibm_backend.py']);

// Same safe-spawn shape as src/engines/execFileAsync.js (argv array, stdin
// closed by default elsewhere isn't applicable here since these scripts
// read their payload FROM stdin by design) -- payload never touches a
// shell, and the process is killed outright on timeout rather than left to
// linger.
export function runPythonQuantumScript(scriptName, payload, { timeoutMs = 60_000 } = {}) {
  if (!ALLOWED_SCRIPTS.has(scriptName)) {
    return Promise.reject(new Error(`refusing to run non-allowlisted quantum script: ${scriptName}`));
  }
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(QUANTUM_SCRIPTS_DIR, scriptName);
    const child = spawn(PYTHON_BIN, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${scriptName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`${scriptName} exited ${code}: ${stderr.slice(0, 2000)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) return reject(new Error(`${scriptName} reported: ${parsed.error}`));
        resolve(parsed);
      } catch {
        reject(new Error(`${scriptName} produced non-JSON output: ${stdout.slice(0, 500)}`));
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function checkPythonModule(moduleName, timeoutMs = 8000) {
  return new Promise((resolve) => {
    // Health only answers whether the deployed runtime contains the module.
    // Importing qiskit_aer loads native numerical libraries and can exceed a
    // gateway timeout on a cold container even though the runtime is valid.
    const child = spawn(PYTHON_BIN, ['-c', `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('${moduleName}') else 1)`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err.message || err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(0, 300) });
    });
  });
}
