import { runContractCases } from '../../../pentest/execution.js';
import { runAdvancedCases } from '../../../pentest/advanced.js';

const definitions = [
  ['AUTHENTICATION_VALIDATION', 'AUTHENTICATION', 'Protected resource authentication validation'],
  ['SESSION_TOKEN_BEHAVIOR', 'SESSION', 'Invalid session/token rejection validation'],
  ['AUTHORIZATION_ACCESS_CONTROL', 'AUTHORIZATION', 'Configured role boundary validation'],
  ['IDOR_BOLA_VALIDATION', 'BOLA', 'Controlled object ownership validation'],
  ['FILE_UPLOAD_SECURITY', 'UPLOAD', 'Inert upload extension validation'],
  ['API_INPUT_VALIDATION', 'API_INPUT', 'Configured API input type validation'],
  ['BUSINESS_LOGIC_VALIDATION', 'BUSINESS_LOGIC', 'Configured invalid workflow transition validation'],
  ...['SQLI','XSS','SSRF','TRAVERSAL','SESSION_LOGOUT','SESSION_EXPIRY','SESSION_FIXATION','MFA','MASS_ASSIGNMENT','GRAPHQL','GRPC','SCHEMA','WORKFLOW','RACE'].map((kind) => [`${kind}_LAB_VERIFICATION`,kind,`${kind} isolated laboratory contract verification`]),
];
export const authenticatedContractModules = definitions.map(([id, kind, name]) => ({
  id, family: kind, name, description: name,
  status: 'IMPLEMENTED', requiredIntrusiveness: 'RESTRICTED',
  isApplicable: (context) => Boolean(context.pentestContext?.engagement.cases.some((c) => c.kind === kind)),
  run: (context) => definitions.slice(0,7).some((entry) => entry[1] === kind) ? runContractCases(kind, id, context) : runAdvancedCases(kind, id, context),
}));
