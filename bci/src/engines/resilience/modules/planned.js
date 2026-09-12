// Registered, real, reviewed future work -- visible via the registry
// (and GET /api/v1/engines/resilience-modules) so the intended full scope
// of BCI Smart Resilience is honest and discoverable, but NEVER run,
// NEVER claimed as executed, and NEVER contributing a round/finding.
// Each is blocked on something concrete this repo doesn't have wired up
// yet, not simply unwritten code -- see bci/README.md's Smart Resilience
// section for the same list with more detail.
export const PLANNED_MODULES = [
  {
    id: 'SOAK_ENDURANCE', family: 'SOAK_ENDURANCE', name: 'Soak / Endurance Load',
    description: 'Real sustained load held for a multi-hour endurance window to surface slow resource leaks/degradation.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'SUSTAINED_LOAD supports user-selected long duration and UNLIMITED request count today. A separately named SOAK_TEST remains planned until it adds distinct soak-specific analysis and durable restart/resume semantics rather than duplicating the existing module.',
  },
  {
    id: 'THROTTLING', family: 'THROTTLING', name: 'Throttling Behavior Validation',
    description: 'Detects gradual, sustained throttling (progressively slower responses under prolonged load) as distinct from a hard rate-limit trigger.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'RATE_LIMIT already covers real hard-429 behavior. A distinct throttling module still needs validated long-window classification logic that separates intentional shaping from ordinary variance.',
  },
  {
    id: 'CONNECTION_RESILIENCE', family: 'CONNECTION_RESILIENCE', name: 'Connection Resilience Validation',
    description: 'Compares real behavior with keep-alive disabled (new TCP/TLS handshake per request) against the default keep-alive path.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'loadEngine.js\'s http/https Agent is currently always keep-alive; a real non-keep-alive comparison run needs a second Agent configuration path not yet built.',
  },
  {
    id: 'KEEP_ALIVE', family: 'KEEP_ALIVE', name: 'Keep-Alive Behavior Validation',
    description: 'Measures real connection reuse rate and its real effect on latency/throughput.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs real per-socket reuse instrumentation (Node\'s Agent does not expose this directly) -- same underlying gap as CONNECTION_RESILIENCE.',
  },
  {
    id: 'HTTP_PROTOCOL_RESILIENCE', family: 'HTTP_PROTOCOL_RESILIENCE', name: 'HTTP Protocol Resilience Validation',
    description: 'Compares real behavior across HTTP/1.1 and HTTP/2 under load.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'loadEngine.js is built on Node\'s http/https modules, fixed at HTTP/1.1 -- a real HTTP/2 client dependency is not wired up.',
  },
  {
    id: 'API_ENDPOINT_CAPACITY', family: 'API_ENDPOINT_CAPACITY', name: 'Per-Endpoint API Capacity Breakdown',
    description: 'A real per-endpoint capacity ceiling, individually, across a set of discovered API endpoints.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'MULTI_ENDPOINT (IMPLEMENTED) already spreads real load across discovered endpoints and reports aggregate metrics; a real per-endpoint breakdown needs per-target bucketing loadEngine.js\'s metrics layer does not yet do.',
  },
  {
    id: 'LARGE_RESPONSE_BEHAVIOR', family: 'LARGE_RESPONSE_BEHAVIOR', name: 'Large Response Body Behavior',
    description: 'Real load against an endpoint known to return a large response body, measuring real throughput/memory behavior.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'loadEngine.js deliberately discards response bodies under load (res.resume(), never buffered) -- identifying a genuinely large-response endpoint safely, without downloading arbitrary bodies at scale, needs a bounded body-size probe this repo does not have yet.',
  },
  {
    id: 'RETRY_BACKOFF', family: 'RETRY_BACKOFF', name: 'Retry / Backoff Behavior Validation',
    description: 'Honors a real observed Retry-After value and checks whether a retried request within that window actually succeeds.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs real cross-round sequencing (a 429+Retry-After observed by RATE_LIMIT feeding directly into this module\'s own execution) that the current one-pass module contract does not yet support.',
  },
  {
    id: 'QUEUE_BACKPRESSURE', family: 'QUEUE_BACKPRESSURE', name: 'Queue Backpressure Validation',
    description: 'Detects real backend queue-depth/backpressure signals under load.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'No generic, application-agnostic HTTP signal exists for backend queue depth without target-specific instrumentation BCI cannot assume is present.',
  },
  {
    id: 'CACHE_BEHAVIOR', family: 'CACHE_BEHAVIOR', name: 'Cache Behavior Validation',
    description: 'Real repeated-request cache-hit-ratio and Cache-Control/ETag behavior under load.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'Needs a real cache-hit signal (X-Cache or equivalent) generalized across arbitrary CDNs/reverse proxies, which this repo has not built detection for yet.',
  },
  {
    id: 'PROXY_CDN_LOAD_BALANCER_BEHAVIOR', family: 'PROXY_CDN_LOAD_BALANCER_BEHAVIOR', name: 'Proxy / CDN / Load-Balancer Behavior',
    description: 'Real distinct-backend-identifier tracking (Server/Via/X-Served-By header variance) across a load round to infer load-balancing behavior.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'loadEngine.js\'s metrics already collect distinctBackendIdentifiers as a real byproduct of every round, but interpreting that into a specific load-balancer/CDN behavior claim needs more real-world validation than this pass could responsibly ship as IMPLEMENTED.',
  },
  {
    id: 'USER_FLOW_SCENARIO', family: 'USER_FLOW_SCENARIO', name: 'Multi-Step User-Flow Scenario Load',
    description: 'Real load replaying a defined multi-step user journey (e.g. login -> browse -> checkout) rather than one endpoint.',
    status: 'PLANNED', requiredIntrusiveness: 'RESTRICTED',
    blockedOn: 'BCI has no user-flow/scenario definition input today -- needs a real journey-definition schema and UI this pass did not build.',
  },
];
