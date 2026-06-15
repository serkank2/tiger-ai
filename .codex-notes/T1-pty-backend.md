## 1. PTY Package Recommendation

Use **`node-pty@^1.1.0` from Microsoft**, not a fork.

Why:

- `node-pty` is the upstream used by VS Code, supports Windows/macOS/Linux, and uses Windows ConPTY on Windows 10 1809+ / Windows 11. See the [README](https://github.com/microsoft/node-pty).
- The current release line has **Node-API/N-API work and published prebuilds** in its release history, which matters because Node-API is ABI-stable across Node majors per the [Node.js docs](https://nodejs.org/api/n-api.html). That gives it the best chance of working on Node 25 without a Node-25-specific binary.
- `@lydell/node-pty` is mainly a smaller packaging wrapper around Microsoft’s package. Its own README says it **only works where prebuilt binaries exist and never calls `node-gyp`**. That is worse for reliability.
- `@homebridge/node-pty-prebuilt-multiarch` is useful for ABI-tagged prebuild coverage, but its latest release calls out **NodeJS 24 support**, not Node 25. See the [release](https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/tag/v0.13.1) and [README](https://github.com/homebridge/node-pty-prebuilt-multiarch).

Fallback if install compiles: use official `node-pty` and let it fall back to `node-gyp`. On Windows install Visual Studio 2022 Build Tools, Desktop C++ workload, Windows SDK, Python, and Spectre-mitigated MSVC libs. Pin `node-pty` in the lockfile and run a smoke test under Node `25.2.1`.

## 2. Module API

```ts
type TerminalState = "running" | "exited" | "error";

type TerminalStatus = {
  id: string;
  name: string;
  state: TerminalState;
  pid?: number;
  cwd: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  signal?: string | null;
  error?: { message: string; code?: string };
  startedAt: string;
  endedAt?: string;
};

type CreateTerminalOptions = {
  name: string;
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
  shellArgs?: string[];
  initialCommand?: string;
  cols?: number;
  rows?: number;
};

interface TerminalProcess {
  id: string;
  name: string;

  status(): TerminalStatus;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;

  stop(opts?: { timeoutMs?: number }): Promise<TerminalStatus>;
  restart(overrides?: Partial<CreateTerminalOptions>): Promise<TerminalStatus>;
  kill(opts?: { force?: boolean }): Promise<TerminalStatus>;
  dispose(): Promise<void>;

  on("output", fn: (e: { id: string; data: string; seq: number }) => void): this;
  on("status", fn: (status: TerminalStatus) => void): this;
  on("exit", fn: (status: TerminalStatus) => void): this;
  on("error", fn: (err: Error) => void): this;
}

interface TerminalManager {
  create(opts: CreateTerminalOptions): Promise<TerminalProcess>;
  get(id: string): TerminalProcess | undefined;
  list(): TerminalStatus[];
  status(id: string): TerminalStatus;

  write(id: string, data: string | Buffer): void;
  resize(id: string, cols: number, rows: number): void;
  stop(id: string): Promise<TerminalStatus>;
  restart(id: string): Promise<TerminalStatus>;
  kill(id: string): Promise<TerminalStatus>;
  remove(id: string): Promise<void>;
  killAll(): Promise<void>;
}
```

Recommendation: `TerminalProcess` owns the pty lifecycle; `TerminalManager` is only the registry, lookup layer, and event fan-out.

## 3. Windows Pitfalls

- **Process tree kill:** do not trust `process.kill()` or pty `.kill()` to clean the whole tree. For forced kill on Windows, run `taskkill /PID <pid> /T /F` with `spawn("taskkill", args, { windowsHide: true })`.

- **Graceful stop:** write `\x03` for Ctrl+C, then optionally `exit\r\n`, wait briefly, then force `taskkill` if still running.

- **Signals:** Unix signals are not portable. Treat terminal control bytes as the portable interface; reserve signals for Unix-only internals.

- **ConPTY:** target Windows 11 with default ConPTY. Do not add winpty support. Only opt into bundled `conpty.dll` behavior if you have a specific Windows console bug to work around.

- **`cwd`:** validate before spawn with `fs.stat`; require an existing directory. Normalize Windows drive/UNC paths. Reject invalid cwd instead of silently falling back.

- **Environment:** merge with `process.env`, preserving `SystemRoot`, `WINDIR`, `ComSpec`, `Path`, `USERPROFILE`. Missing `SystemRoot` can break PowerShell, as noted in `node-pty` troubleshooting.

- **Initial command:** avoid shell-string spawning. Spawn the shell with args, then write `initialCommand + "\r\n"` after the pty is ready.

- **Concurrency:** keep all `node-pty` access on one Node thread; upstream notes it is not thread-safe. Use per-terminal output sequence numbers and bounded ring buffers.