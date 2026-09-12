# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in BQI — particularly anything touching authentication (`server/src/routes/auth.js`), the emergency broadcast system (`server/src/routes/emergency.js`), file uploads, or the fraud/AML detection module — please report it privately rather than opening a public GitHub issue.

Email **info@boldas.com.tr** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce it (a minimal request/response example is ideal)
- Any suggested fix, if you have one

Please allow a reasonable amount of time for a response before any public disclosure.

## Scope Notes

- This is a decision-support application handling analysis reports, emergency coordination, and (in the BDDK/BTK modules) financial anomaly detection. Vulnerabilities affecting confidentiality or integrity of report content, authentication bypass, or privilege escalation (e.g., a non-admin reaching `/api/*/admin/*` routes) are treated as high severity.
- See the README's **Security Notes** section for already-documented, intentional behavior (e.g., admin logins skipping mail approval) — these are known trade-offs, not vulnerabilities, unless you've found a way to abuse them beyond their documented scope.
