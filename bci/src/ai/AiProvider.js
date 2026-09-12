// AI provider contract (spec section 41, 43). Every provider:
//   { id, mode, async healthCheck(): {status, detail?}, async generate({prompt}): {text} }
// generate() must never throw for "the AI said something weird" -- only for
// genuine transport failure, which the caller (decisionSupport.js) always
// catches and falls back from. AI is never on the path that makes a
// security decision (scope authorization, RBAC, policy) -- only on the
// path that explains one already made deterministically.
export function assertValidProvider(provider) {
  const required = ['id', 'mode', 'healthCheck', 'generate'];
  const missing = required.filter((k) => provider[k] === undefined);
  if (missing.length > 0) throw new Error(`Invalid AI provider: missing ${missing.join(', ')}`);
}
