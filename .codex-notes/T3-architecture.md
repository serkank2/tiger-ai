## Decision: Pick **B**

Use a **separate standalone Node backend** with `Express`/`ws`/native `pty`, plus a **Nuxt 3 frontend** that connects to it.

Why:

- Native `pty` modules are better kept out of the Nuxt/Nitro/Vite build pipeline.
- Terminal processes should not be tied to frontend rebuilds, HMR, route reloads, or Nitro lifecycle quirks.
- The backend can keep terminals alive while the Nuxt UI restarts independently.
- Debugging is clearer: one process owns terminals, one process owns UI.
- For a local-only single-user app, two local processes are still simple and much more reliable.

Option A is attractive for “one app,” but terminal lifecycle management is backend stateful infrastructure. Keep it outside Nuxt.

## Project Structure

```txt
terminal-manager/
  package.json
  pnpm-workspace.yaml

  apps/
    backend/
      package.json
      src/
        index.ts
        server.ts
        terminal/
          TerminalManager.ts
          TerminalSession.ts
        ws/
          terminalSocket.ts
      tsconfig.json

    frontend/
      package.json
      nuxt.config.ts
      app.vue
      pages/
        index.vue
      components/
        TerminalPane.vue
      composables/
        useTerminalSocket.ts
```

Backend responsibilities:

```txt
apps/backend
- Owns node-pty
- Creates/kills terminal sessions
- Keeps terminal sessions alive
- Exposes WebSocket API
- Optional REST endpoints for health/session listing
```

Frontend responsibilities:

```txt
apps/frontend
- Nuxt 3 UI
- xterm.js rendering
- Connects to ws://localhost:4000
- Can restart freely without killing terminals
```

## Dev Workflow

From repo root:

```bash
pnpm install
```

Run backend:

```bash
pnpm --filter backend dev
```

Run frontend:

```bash
pnpm --filter frontend dev
```

Suggested ports:

```txt
Backend:  http://localhost:4000
WebSocket: ws://localhost:4000/terminals
Frontend: http://localhost:3000
```

Root `package.json` scripts:

```json
{
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "dev:backend": "pnpm --filter backend dev",
    "dev:frontend": "pnpm --filter frontend dev",
    "build": "pnpm -r build",
    "start": "pnpm --filter backend start"
  }
}
```

## Local Run Workflow

Build both:

```bash
pnpm build
```

Start backend:

```bash
pnpm --filter backend start
```

Start Nuxt preview or static/local frontend:

```bash
pnpm --filter frontend preview
```

For a personal local app, you can later wrap both processes with a small launcher script, but keep the architecture split. The backend is the durable terminal host; Nuxt is just the UI.