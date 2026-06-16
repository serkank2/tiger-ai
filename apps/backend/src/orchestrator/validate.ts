import { promises as fs } from 'node:fs';

export interface OutputCheck {
  ok: boolean;
  exists: boolean;
  size: number;
  reason?: string;
}

/**
 * Completion-detection check #3 + #4 (spec): the expected output file exists and is
 * not empty. "Empty" means zero bytes or whitespace-only.
 */
export async function checkOutputFile(file: string): Promise<OutputCheck> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return { ok: false, exists: false, size: 0, reason: 'output file was not created' };
  }
  if (!st.isFile()) return { ok: false, exists: false, size: 0, reason: 'output path is not a file' };
  if (st.size === 0) return { ok: false, exists: true, size: 0, reason: 'output file is empty' };
  // Guard against whitespace-only files (cheap for the small-to-moderate outputs here).
  try {
    const content = await fs.readFile(file, 'utf8');
    if (content.trim().length === 0) {
      return { ok: false, exists: true, size: st.size, reason: 'output file contains only whitespace' };
    }
  } catch {
    /* unreadable but non-zero — treat the size check as authoritative */
  }
  return { ok: true, exists: true, size: st.size };
}

/** Whether the completion marker file exists. */
export async function markerExists(markerFile: string): Promise<boolean> {
  try {
    await fs.access(markerFile);
    return true;
  } catch {
    return false;
  }
}
