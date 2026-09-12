// Spec section 36: evidence must never carry secrets/tokens/cookies in the
// clear. Raw request/response text (nuclei's evidence, mainly) is the one
// place a real credential could end up verbatim, so it's redacted line by
// line before anything is stored as "evidence" on a normalized observation.
const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization):.*$/i;

export function redactHttpText(text) {
  if (typeof text !== 'string') return text;
  return text
    .split(/\r?\n/)
    .map((line) => (SENSITIVE_HEADER_PATTERN.test(line.trim()) ? line.replace(/:.*/, ': [REDACTED]') : line))
    .join('\n');
}
