/**
 * Helpers for the lightweight placeholder shown on suspended (off-screen, virtualized)
 * terminal tiles. A suspended tile has no live xterm, so the grid still shows the
 * terminal's name/status plus the last line of captured output as a "what was here"
 * hint. The full scrollback is replayed by the backend when the tile re-attaches.
 */

/** Last non-empty, trimmed line of a captured terminal output buffer (CR-stripped). */
export function lastOutputLine(output: string | null | undefined): string {
  if (!output) return '';
  const lines = output.replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i]!.trim();
    if (s) return s;
  }
  return '';
}
