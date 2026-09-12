// AI DLP layer (spec section 43): runs on ANY text before it leaves the
// process toward an EXTERNAL_AI provider. Independent of and in addition to
// src/normalization/redact.js (which only handles HTTP evidence) --
// this one scans free-form text for secret-shaped substrings anywhere.
const PATTERNS = [
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { name: 'generic_api_key_assignment', re: /(api[_-]?key|apikey|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{8,}["']?/gi },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function redactForExternalAi(text) {
  if (typeof text !== 'string') return text;
  let redacted = text;
  for (const { re } of PATTERNS) {
    redacted = redacted.replace(re, '[REDACTED]');
  }
  return redacted;
}
