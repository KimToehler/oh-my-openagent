const DEFAULT_MAX_LENGTH = 2000

// A blocked child authors `reason` and `needs` freely, and both are rendered
// into the PARENT's `<system-reminder>` envelope. Untreated, a child can close
// that envelope and speak to its parent as if it were the system, or blow the
// parent's context with one enormous field. Neutralize both before interpolation.
const ENVELOPE_PATTERN = /<\/?system-reminder>/gi

export function sanitizeUntrustedText(value: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  const withoutEnvelope = value.replace(ENVELOPE_PATTERN, (match) => match.replace(/[<>]/g, ""))
  const collapsed = withoutEnvelope.replace(/\r\n?/g, "\n")
  if (collapsed.length <= maxLength) return collapsed
  const truncated = collapsed.slice(0, maxLength)
  return `${truncated}\n[truncated ${collapsed.length - maxLength} characters]`
}
