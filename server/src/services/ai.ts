/**
 * BQI AI Service
 * Barrel module preserving the original public API of this file. The
 * actual implementation is split across:
 *  - aiProviders.ts  -- provider clients (Claude/Gemini/OpenAI), model IDs, getStatus()
 *  - aiPrompts.ts    -- category grouping and system prompt construction
 *  - aiGenerate.ts   -- the provider-fallback generation/streaming/parsing calls
 * Kept as a barrel (rather than updating every import site) so every
 * existing `from '../services/ai.js'` import and test mock keeps working
 * unchanged.
 */
export { getStatus } from './aiProviders.js';
export {
  isFraudCategory,
  getCategoryGroup,
  CATEGORY_GROUP_SOURCES,
  getSystemPromptForCategory,
  getQuantumSystemPrompt,
  getScenarioDeepDivePrompt,
  getConsultationPrompt,
  wrapUntrustedEvidence,
} from './aiPrompts.js';
export type { CategoryGroup } from './aiPrompts.js';
export {
  AllProvidersFailedError,
  PolicyDenialError,
  generateAnalysis,
  generateAnalysisWithVision,
  streamConsultationText,
  parseVoiceIntent,
  generateStructured,
} from './aiGenerate.js';
export type { VoiceIntentResult } from './aiGenerate.js';
