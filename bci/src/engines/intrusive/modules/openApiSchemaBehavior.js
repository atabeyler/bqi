import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'OPENAPI_SCHEMA_BEHAVIOR';

function resolveRef(spec, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.split('/').slice(1).reduce((value, key) => value?.[key], spec);
}

function valueMatchesType(value, type) {
  if (!type) return true;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return true;
}

function responseSchema(spec, operation) {
  const responses = operation.responses || {};
  const response = responses['200'] || responses['201'] || responses.default;
  return resolveRef(spec, response?.content?.['application/json']?.schema || response?.schema);
}

export const openApiSchemaBehaviorModule = {
  id: 'OPENAPI_SCHEMA_BEHAVIOR', family: FAMILY, name: 'OpenAPI / API Schema Behavior Validation',
  description: 'Executes bounded safe GET operations and validates real JSON responses against declared required fields and primitive types.',
  status: 'IMPLEMENTED', requiredIntrusiveness: 'RESTRICTED',
  isApplicable: ({ openapiSpec }) => !!openapiSpec?.paths,

  async run({ target, openapiSpec, openapiSource, timeoutMs, headers = [], roundNumber = 1 }) {
    const records = [];
    const origin = new URL(target).origin;
    const basePath = typeof openapiSpec.basePath === 'string' ? openapiSpec.basePath : '';
    const operations = Object.entries(openapiSpec.paths || {})
      .filter(([route]) => !route.includes('{'))
      .map(([route, pathItem]) => ({ route, operation: pathItem?.get }))
      .filter(({ operation }) => operation && responseSchema(openapiSpec, operation))
      .slice(0, 5);
    for (const { route, operation } of operations) {
      const endpoint = new URL(`${basePath}${route}`, origin).toString();
      try {
        const response = await curlFetch(endpoint, { method: 'GET', headers: [...headers, 'Accept: application/json'], timeoutMs });
        let body;
        try { body = JSON.parse(response.body); } catch { body = null; }
        const schema = resolveRef(openapiSpec, responseSchema(openapiSpec, operation)) || {};
        const missing = (schema.required || []).filter((key) => body == null || !Object.hasOwn(body, key));
        const typeMismatches = Object.entries(schema.properties || {}).filter(([key, definition]) => (
          body != null && Object.hasOwn(body, key) && !valueMatchesType(body[key], resolveRef(openapiSpec, definition)?.type)
        )).map(([key]) => key);
        const reasons = [];
        if (response.status < 300 && body == null) reasons.push('declared_json_response_is_not_json');
        if (missing.length) reasons.push('openapi_required_fields_missing');
        if (typeMismatches.length) reasons.push('openapi_response_type_mismatch');
        records.push(buildRecord({
          moduleId: this.id, family: FAMILY, target, endpoint, testType: 'OPENAPI_RESPONSE_CONFORMANCE',
          baseline: { openapiSource, expectedType: schema.type || 'object', required: schema.required || [] },
          observed: { status: response.status, contentType: response.headers['content-type'] || null },
          evidence: { missingRequiredFields: missing, typeMismatches }, verificationStatus: 'VERIFIED', roundNumber,
          anomalous: reasons.length > 0, anomalyReasons: reasons,
        }));
      } catch (err) {
        records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, endpoint, testType: 'OPENAPI_RESPONSE_CONFORMANCE', error: err, roundNumber }));
      }
    }
    return records.length ? records : [buildRecord({
      moduleId: this.id, family: FAMILY, target, testType: 'OPENAPI_RESPONSE_CONFORMANCE',
      baseline: { openapiSource }, observed: null, evidence: { reason: 'no safe GET operation with a declared JSON response schema' },
      verificationStatus: 'NOT_APPLICABLE', roundNumber, anomalous: false,
    })];
  },
};
