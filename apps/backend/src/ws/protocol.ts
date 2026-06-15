import type { CommandTarget, TerminalRunState } from '../store/types.js';

// ---------------------------------------------------------------------------
// WebSocket message protocol. One socket per browser window; terminals are
// multiplexed by `termId`. (Protocol adopted from the Codex T2 design; hosted
// on the standalone `ws` server rather than Nitro, per the chosen architecture.)
// ---------------------------------------------------------------------------

// ---- Client -> Server ----

export interface AttachMsg {
  type: 'term.attach';
  termId: string;
  id?: string;
}
export interface DetachMsg {
  type: 'term.detach';
  termId: string;
}
/** Raw interactive keystrokes from xterm — written to the pty verbatim. */
export interface InputMsg {
  type: 'term.input';
  termId: string;
  data: string;
}
export interface ResizeMsg {
  type: 'term.resize';
  termId: string;
  cols: number;
  rows: number;
}
/** Command-bar send to selected / group / all. Newline handling is explicit. */
export interface BroadcastInputMsg {
  type: 'term.broadcastInput';
  id?: string;
  target: CommandTarget;
  data: string;
  appendNewline?: boolean;
}
export interface PingMsg {
  type: 'ping';
  ts?: number;
}

export type ClientMsg =
  | AttachMsg
  | DetachMsg
  | InputMsg
  | ResizeMsg
  | BroadcastInputMsg
  | PingMsg;

// ---- Server -> Client ----

export interface AttachedMsg {
  type: 'term.attached';
  termId: string;
  id?: string;
  state: TerminalRunState;
  cols: number;
  rows: number;
}
export interface OutputMsg {
  type: 'term.output';
  termId: string;
  data: string;
}
export interface StatusMsg {
  type: 'term.status';
  termId: string;
  state: TerminalRunState;
  pid?: number;
}
export interface ExitMsg {
  type: 'term.exit';
  termId: string;
  exitCode: number | null;
  signal?: number | null;
}
export interface ErrorMsg {
  type: 'term.error';
  termId?: string;
  id?: string;
  code?: string;
  message: string;
}
export interface BroadcastResultMsg {
  type: 'term.broadcastResult';
  id?: string;
  matched: number;
  written: number;
  failed: { termId: string; code: string }[];
}
export interface PongMsg {
  type: 'pong';
  ts?: number;
}

export type ServerMsg =
  | AttachedMsg
  | OutputMsg
  | StatusMsg
  | ExitMsg
  | ErrorMsg
  | BroadcastResultMsg
  | PongMsg;

/** Narrowing parse for an incoming client message. Returns null when invalid. */
export function parseClientMessage(raw: string): ClientMsg | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const msg = obj as { type?: unknown };
  if (typeof msg.type !== 'string') return null;
  // Trust the discriminant; the dispatcher validates fields it actually uses.
  return obj as ClientMsg;
}
