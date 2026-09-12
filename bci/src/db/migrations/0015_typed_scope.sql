-- Q1/section 4: typed scope authorization. A bare string suffix match is
-- not a production authorization boundary -- a CIDR, a URL path, and a
-- repository identity all need their own canonical matcher
-- (src/lib/targetMatcher.js), not one generic string comparison.

ALTER TABLE authorized_scopes ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'DOMAIN';
ALTER TABLE authorized_scopes ADD CONSTRAINT authorized_scopes_target_type_check
  CHECK (target_type IN (
    'DOMAIN', 'SUBDOMAIN', 'URL', 'IP', 'CIDR', 'REPOSITORY',
    'API', 'CLOUD_ACCOUNT', 'CONTAINER', 'KUBERNETES_CLUSTER'
  ));
