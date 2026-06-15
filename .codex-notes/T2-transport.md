## 1. Transport

Use **Nitro built-in WebSocket with `defineWebSocketHandler`**.

For a single-user local Nuxt 3 app, it is the right default: same origin/port as the UI, no extra server, works with native browser `WebSocket`, and gives you direct route-based handlers plus peer/topic pub-sub. Nitro’s WebSocket support is powered by CrossWS/H3, and CrossWS uses `ws` for Node support, so you are not giving up the Node backend path.

Do **not** use Socket.IO here. Its reconnects, rooms, fallback transports, and packet buffering are useful for internet-facing multi-client apps, but they add protocol overhead and a non-WebSocket client/server contract. Do **not** start with standalone `ws` unless you split the PTY manager into a separate Node service or need lower-level send-buffer control.

Sources: [Nitro WebSocket docs](https://nitro.build/docs/websocket), [CrossWS](https://crossws.h3.dev/), [Socket.IO docs](https://socket.io/docs/v4/).

## 2. Message Protocol

Use one WebSocket connection per browser window. Multiplex terminals by `termId`.

Common envelope:

```ts
type Msg = {
  type: string
  id?: string        // client-generated request id
  termId?: string
  ts?: number
}
```

### Attach / Subscribe

Client to server:

```json
{
  "type": "term.attach",
  "id": "req-1",
  "termId": "term-abc",
  "replayFrom": 18420
}
```

Server to client:

```json
{
  "type": "term.attached",
  "id": "req-1",
  "termId": "term-abc",
  "status": "running",
  "cols": 120,
  "rows": 32,
  "seq": 18457
}
```

Detach:

```json
{
  "type": "term.detach",
  "termId": "term-abc"
}
```

### Output Chunk

Server to client:

```json
{
  "type": "term.output",
  "termId": "term-abc",
  "seq": 18458,
  "data": "npm run dev\r\n...",
  "encoding": "utf8"
}
```

If you later need binary-safe transport:

```json
{
  "type": "term.output",
  "termId": "term-abc",
  "seq": 18459,
  "data": "base64-encoded-bytes",
  "encoding": "base64"
}
```

### Input / Keystrokes

Client to server:

```json
{
  "type": "term.input",
  "termId": "term-abc",
  "data": "\u0003"
}
```

For pasted commands or explicit command submission:

```json
{
  "type": "term.input",
  "termId": "term-abc",
  "data": "git status\r"
}
```

### Resize

Client to server:

```json
{
  "type": "term.resize",
  "termId": "term-abc",
  "cols": 140,
  "rows": 36
}
```

Server acknowledgement, optional:

```json
{
  "type": "term.resized",
  "termId": "term-abc",
  "cols": 140,
  "rows": 36
}
```

### Lifecycle / Status

Server to client:

```json
{
  "type": "term.status",
  "termId": "term-abc",
  "status": "starting"
}
```

```json
{
  "type": "term.exit",
  "termId": "term-abc",
  "exitCode": 0,
  "signal": null
}
```

```json
{
  "type": "term.error",
  "termId": "term-abc",
  "code": "PTY_WRITE_FAILED",
  "message": "PTY is no longer writable"
}
```

Suggested statuses:

```ts
"starting" | "running" | "exited" | "failed" | "detached"
```

### Command To Many

Client to server:

```json
{
  "type": "term.broadcastInput",
  "id": "req-22",
  "target": {
    "mode": "selected",
    "termIds": ["term-a", "term-b", "term-c"]
  },
  "data": "git pull\r"
}
```

Group:

```json
{
  "type": "term.broadcastInput",
  "id": "req-23",
  "target": {
    "mode": "group",
    "groupId": "backend"
  },
  "data": "npm test\r"
}
```

All:

```json
{
  "type": "term.broadcastInput",
  "id": "req-24",
  "target": {
    "mode": "all"
  },
  "data": "\u0003"
}
```

Server result:

```json
{
  "type": "term.broadcastResult",
  "id": "req-24",
  "matched": 12,
  "written": 11,
  "failed": [
    {
      "termId": "term-z",
      "code": "PTY_NOT_RUNNING"
    }
  ]
}
```

## 3. Backpressure, Throughput, Reconnect

Coalesce PTY output. Do not send one WebSocket message per `data` event. Buffer per terminal and flush every `8-16ms` or when the buffer reaches `16-64KB`.

Use per-client send queues. Track queued bytes. If a browser falls behind, pause PTY reads if supported; otherwise drop old scrollback-bound output after a limit and send:

```json
{
  "type": "term.outputDropped",
  "termId": "term-abc",
  "droppedBytes": 98304,
  "reason": "client_backpressure"
}
```

Keep a ring buffer per terminal, for example last `1-10MB` or last `N` chunks, with monotonic `seq`. On reconnect, the client sends:

```json
{
  "type": "session.resume",
  "lastSeqByTerm": {
    "term-a": 18458,
    "term-b": 992
  }
}
```

Server replies with replayable chunks where available, otherwise sends a resync notice:

```json
{
  "type": "term.resyncRequired",
  "termId": "term-a",
  "reason": "replay_buffer_expired",
  "latestSeq": 19120
}
```

Use heartbeat:

```json
{ "type": "ping", "ts": 1781511112000 }
```

```json
{ "type": "pong", "ts": 1781511112000 }
```

Reconnect with exponential backoff plus jitter. After reconnect, resubscribe/reattach to visible terminals, restore sizes, then resume output from last seen `seq`.

Bottom line: **Nitro WebSocket + native browser WebSocket + app-level multiplexing and flow control** is the cleanest fit.