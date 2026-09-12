// Intentionally insecure fixture used only by test/engines.test.js to prove
// the Semgrep adapter can find something real. Never imported by app code.
function runUserExpression(userInput) {
  // eval() on unsanitized input is flagged by essentially every JS security
  // ruleset (semgrep's own registry included) -- a robust, low-flake choice
  // for a "does the adapter actually find something" smoke test.
  return eval(userInput);
}

module.exports = { runUserExpression };
