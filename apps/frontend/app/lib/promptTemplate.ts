// Prompt templating: {{variable}} placeholders with built-ins and escaping.
// Pure functions (no Vue) so they're unit-testable with tsx.

const VAR = /(\\?)\{\{\s*([\w.]+)\s*\}\}/g;
const BUILTINS = new Set(['terminal.name', 'terminal.cwd', 'date']);

/** User-defined variable names found in the body (built-ins and escaped ones excluded). */
export function detectVariables(body: string): string[] {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  VAR.lastIndex = 0;
  while ((m = VAR.exec(body))) {
    if (m[1] === '\\') continue; // escaped \{{x}} → literal
    if (!BUILTINS.has(m[2]!)) set.add(m[2]!);
  }
  return [...set];
}

export interface RenderCtx {
  values: Record<string, string>;
  terminal?: { name: string; cwd: string };
  date?: string;
}

/** Render the body. Escaped `\{{x}}` → `{{x}}`; unresolved user vars are left as-is. */
export function render(body: string, ctx: RenderCtx): string {
  return body.replace(VAR, (full, esc: string, name: string) => {
    if (esc === '\\') return full.slice(1);
    if (name === 'terminal.name') return ctx.terminal?.name ?? '';
    if (name === 'terminal.cwd') return ctx.terminal?.cwd ?? '';
    if (name === 'date') return ctx.date ?? '';
    // Blank/whitespace value → leave the placeholder visible rather than silently emptying it.
    return name in ctx.values && ctx.values[name]!.trim() !== '' ? ctx.values[name]! : full;
  });
}

/** True if the body uses a per-terminal built-in (forces per-terminal rendering on send). */
export function hasPerTerminalVars(body: string): boolean {
  let m: RegExpExecArray | null;
  VAR.lastIndex = 0;
  while ((m = VAR.exec(body))) {
    if (m[1] !== '\\' && (m[2] === 'terminal.name' || m[2] === 'terminal.cwd')) return true;
  }
  return false;
}
