/** Best-effort human-readable message from a failed $fetch / API error. */
export function errText(e: unknown): string {
  const err = e as { data?: { error?: { message?: string } }; message?: string };
  return err?.data?.error?.message ?? err?.message ?? 'Request failed';
}
