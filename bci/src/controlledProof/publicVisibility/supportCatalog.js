// Provider support is deliberately explicit. Detection is not capability:
// a recognizable platform is IMPLEMENTED only when BCI has a production
// adapter that can inject the fixed marker into the public HTML, enforce an
// absolute self-expiry, independently observe it, and verify removal.
export const PUBLIC_VISIBILITY_SUPPORT = Object.freeze([
  { id: 'cloudflare', label: 'Cloudflare', adapterId: 'cloudflare-edge-worker', adapterStatus: 'IMPLEMENTED' },
  { id: 'aws-cloudfront', label: 'AWS CloudFront', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_edge_deployment' },
  { id: 'fastly', label: 'Fastly', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_edge_deployment' },
  { id: 'akamai', label: 'Akamai', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_edge_deployment' },
  { id: 'azure-front-door', label: 'Azure Front Door', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_not_supported_by_rules_engine' },
  { id: 'google-cloud', label: 'Google Cloud CDN / Firebase Hosting', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'vercel', label: 'Vercel', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'netlify', label: 'Netlify', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'aws-amplify', label: 'AWS Amplify Hosting', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'azure-static-web-apps', label: 'Azure Static Web Apps', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'microsoft-iis', label: 'Microsoft IIS', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'origin_change_has_no_safe_self_expiry' },
  { id: 'nginx', label: 'Nginx', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'origin_change_has_no_safe_self_expiry' },
  { id: 'apache-httpd', label: 'Apache HTTP Server', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'origin_change_has_no_safe_self_expiry' },
  { id: 'kubernetes-ingress', label: 'Kubernetes Ingress', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'requires_preinstalled_response_transform' },
  { id: 'wordpress', label: 'WordPress', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'cms_content_change_is_persistent' },
  { id: 'drupal', label: 'Drupal', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'cms_content_change_is_persistent' },
  { id: 'wix', label: 'Wix', adapterId: null, adapterStatus: 'BLOCKED', blockingReason: 'response_body_transform_requires_site_deployment' },
  { id: 'unknown-custom', label: 'Unknown / Custom Infrastructure', adapterId: null, adapterStatus: 'UNSUPPORTED', blockingReason: 'unknown_infrastructure_no_verified_management_path' },
]);

export function publicVisibilitySupport(providerId) {
  return PUBLIC_VISIBILITY_SUPPORT.find((provider) => provider.id === providerId) || {
    id: providerId,
    label: providerId,
    adapterId: null,
    adapterStatus: 'UNSUPPORTED',
    blockingReason: 'unknown_infrastructure_no_verified_management_path',
  };
}
