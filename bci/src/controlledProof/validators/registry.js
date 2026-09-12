import { responseReflectionValidator } from './responseReflection.js';

const VALIDATORS = [responseReflectionValidator];
const byId = new Map(VALIDATORS.map((validator) => [validator.id, validator]));
if (byId.size !== VALIDATORS.length) throw new Error('duplicate_controlled_proof_validator');

export function listProofValidators() {
  return [...VALIDATORS];
}

export function getProofValidator(id) {
  return byId.get(id) || null;
}
