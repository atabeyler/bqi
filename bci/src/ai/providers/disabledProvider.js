// The default provider (spec section 43: AI_DISABLED). Always reports
// unavailable so callers take the deterministic fallback path -- this is
// not an error state, it's a fully supported production configuration.
export const disabledProvider = {
  id: 'disabled',
  mode: 'AI_DISABLED',

  async healthCheck() {
    return { status: 'OFFLINE', detail: 'AI is disabled (BCI_AI_MODE=AI_DISABLED)' };
  },

  async generate() {
    throw new Error('AI is disabled');
  },
};
