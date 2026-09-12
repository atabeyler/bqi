/**
 * BQI Abstract RBAC/ABAC
 * -----------------------------
 * Replaces the previous binary user/admin authorization with a small role
 * model (admin/analyst/viewer) combined with attribute-based access control
 * over the data classification already computed for every analysis (see
 * decisionIntelligence.js's classifyData: PUBLIC/INTERNAL/CONFIDENTIAL/
 * RESTRICTED).
 *
 * This is deliberately a GENERIC role model, not a real institutional org
 * chart (units, ranks, departments) -- no such structure was specified.
 * When one is available, map its real roles onto these three tiers (or
 * extend ROLE_MAX_CLASSIFICATION with more roles) rather than rewriting
 * every call site that uses resolveRole()/canAccessClassification().
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  ANALYST: 'analyst',
  VIEWER: 'viewer',
});

const CLASSIFICATION_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

// The highest data classification each role may access at all (view,
// export, download, email alike -- individual call sites decide which of
// those actions to gate, see canAccessClassification()).
const ROLE_MAX_CLASSIFICATION = {
  [ROLES.ADMIN]: 'RESTRICTED',
  [ROLES.ANALYST]: 'CONFIDENTIAL',
  [ROLES.VIEWER]: 'INTERNAL',
};

/**
 * Resolves a user's role from JWT claims. A `role` claim that's present but
 * unrecognized (typo'd, tampered, from a future/rolled-back token version)
 * is treated as untrusted input and gets the least-privilege role, not a
 * silent analyst-level pass. Only a token with NO `role` claim at all --
 * i.e. one issued before the claim existed -- falls back to the legacy
 * isAdmin boolean, which is the same access level ordinary non-admin
 * accounts already had pre-RBAC.
 */
export function resolveRole(user) {
  if (user?.role) {
    return Object.prototype.hasOwnProperty.call(ROLE_MAX_CLASSIFICATION, user.role) ? user.role : ROLES.VIEWER;
  }
  return user?.isAdmin ? ROLES.ADMIN : ROLES.ANALYST;
}

/**
 * @param {object} user - req.user (decoded JWT)
 * @param {string} classification - one of CLASSIFICATION_LEVELS; an
 *        unrecognized/missing value is treated as INTERNAL (the existing
 *        default in decisionIntelligence.js's classifyData), not blocked.
 */
export function canAccessClassification(user, classification) {
  const role = resolveRole(user);
  const maxIndex = CLASSIFICATION_LEVELS.indexOf(ROLE_MAX_CLASSIFICATION[role]);
  const requestedIndex = CLASSIFICATION_LEVELS.indexOf(classification);
  const effectiveIndex = requestedIndex === -1 ? CLASSIFICATION_LEVELS.indexOf('INTERNAL') : requestedIndex;
  return effectiveIndex <= maxIndex;
}

/** Express middleware: 403s unless the resolved role is one of `allowedRoles`. */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(resolveRole(req.user))) {
      return res.status(403).json({ error: 'Yetkisiz' });
    }
    next();
  };
}

/**
 * Express middleware factory: 403s unless the caller's role can access the
 * classification returned by `getClassification(req, res)`. Intended to
 * run AFTER the resource has been fetched (getClassification typically
 * reads it off res.locals or a value stashed by an earlier handler) --
 * see routes/platform.js's /decisions/:analysisId for the usage pattern.
 */
export function requireClassificationAccess(getClassification) {
  return (req, res, next) => {
    const classification = getClassification(req, res);
    if (!canAccessClassification(req.user, classification)) {
      return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
    }
    next();
  };
}
