// Registered, real, reviewed future work -- visible in the registry (and
// GET /api/v1/engines/intrusive-modules) so the intended full scope of
// BCI Smart Intrusive is honest and discoverable, but NEVER run, NEVER
// claimed as executed, and NEVER contributing a finding. Each one is
// blocked on something concrete this repo doesn't have wired up yet
// (documented per module) rather than being simply unwritten code -- see
// bci/README.md's Smart Intrusive section for the same list with more
// detail. A module moves from here to its own real modules/*.js file
// (registered in registry.js) once that blocker is actually resolved --
// the registry shape itself needs no change to accept it.
export const PLANNED_MODULES = [
  {
    id: 'AUTHENTICATION_VALIDATION', family: 'AUTHENTICATION_VALIDATION', name: 'Authentication Validation',
    description: 'Validates authentication mechanism behavior (lockout, credential stuffing resistance, MFA bypass patterns).',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs a real credential/session material input BCI does not yet accept end to end (see Smart Fuzz\'s authHeader, which is adapter-level only, not yet wired through scan_jobs).',
  },
  {
    id: 'SESSION_TOKEN_BEHAVIOR', family: 'SESSION_TOKEN_BEHAVIOR', name: 'Session / Token Behavior Validation',
    description: 'Validates session fixation, token entropy, and expiry/rotation behavior.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs a real authenticated session to observe -- same credential-material gap as AUTHENTICATION_VALIDATION.',
  },
  {
    id: 'AUTHORIZATION_ACCESS_CONTROL', family: 'AUTHORIZATION_ACCESS_CONTROL', name: 'Authorization / Access-Control Validation',
    description: 'Validates role/permission boundary enforcement across authenticated requests.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs two distinct real authenticated identities to compare -- not something BCI can responsibly self-provision.',
  },
  {
    id: 'IDOR_BOLA_VALIDATION', family: 'IDOR_BOLA_VALIDATION', name: 'IDOR / BOLA Behavior Validation',
    description: 'Validates object-level authorization by requesting an adjacent identifier under a different session.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Same real-multi-identity gap as AUTHORIZATION_ACCESS_CONTROL; also needs care to stay non-destructive against a live target\'s real user data.',
  },
  {
    id: 'RATE_LIMIT_THROTTLING_ACTIVE', family: 'RATE_LIMIT_THROTTLING_BEHAVIOR', name: 'Active Rate-Limit / Throttling Trigger',
    description: 'Deliberately exceeds an advertised rate limit to confirm it is actually enforced, not just advertised.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'By definition a burst/load pattern -- belongs under the separate DOS capability (availability-probe), not INTRUSIVE, per this task\'s own instruction to keep them apart. RATE_LIMIT_HEADER_OBSERVATION (IMPLEMENTED) covers the passive half of this family today.',
  },
  {
    id: 'FILE_UPLOAD_SECURITY', family: 'FILE_UPLOAD_SECURITY', name: 'File-Upload Security Validation',
    description: 'Validates upload endpoint content-type/extension enforcement.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs a real, safe (non-destructive) file payload strategy and a discovered real upload endpoint -- higher-risk than this pass could responsibly rush.',
  },
];
