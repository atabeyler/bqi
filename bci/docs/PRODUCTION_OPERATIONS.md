# Production integration and recovery contracts

These commands operate real services. A submitted provisioning request is not a
readiness result. Run them with a separate operator identity; do not give the
worker provisioning, backup-export, IAM administration or bucket-policy rights.
No production infrastructure is provisioned by GitHub Actions.

## Authorization and worker isolation

Normal API/worker execution requires a current, approved, tenant-bound scope
including the requested scan class. Exclusions override overlapping grants.
Workers recheck scope before each engine; authenticated HTTP exchanges also
recheck the actual endpoint. A LAB/STAGING label from an API client cannot relax
network or mutation rules. Operators configure exact origins, including ports,
in `BCI_NATIVE_LAB_ORIGINS` and `BCI_STAGING_ORIGINS`; paths, credentials and
wildcards are invalid. Keep the lab list empty in production.
Controlled Proof and live finding rechecks use the same authorized transport;
an unreachable HTTP control cannot establish FIX_VERIFIED.

`BCI_ALLOW_UNSCOPED_TESTS=1` is a compatibility switch inside the isolated
`NODE_ENV=test` Vitest harness only. Production ignores it. This does not change
the BCI user/role permission catalog.

Generate a worker role with `node scripts/iam-lifecycle.mjs plan config.json`.
The config contains `accountId`, `region`, `tenantId`, `keyArn`, `archiveBucket`,
`checkpointBucket`, `oidcIssuer`, optional `archiveKeyArn`, `customKeyStoreId`,
`namespace` and `serviceAccount`. Keys must belong to that account/region; the
OIDC issuer must be the exact EKS issuer. The default service account is
`bci-worker-<tenant UUID>`. A custom identity must include the tenant UUID in its
namespace or service-account name. Set `BCI_WORKER_ORG_ID` to that same UUID;
the queue then claims only that tenant's jobs. Provision with the operator-only
`BCI_CLOUD_PROVISIONING_APPROVED=1` and the `provision` operation. Apply the
returned identity and role ARN to the deployment; no persistent AWS access key
is generated. An IAM key policy must also admit this role and its encryption
contexts. Runtime evidence and credential contexts are separate.

Apply `deploy/worker-network-policy.yaml` with an enforcing CNI, not merely an
API server accepting YAML. Add only the approved target/provider IPs and ports.
The default policy denies DNS and public egress. DNS pinning in the application
does not replace CNI/kernel enforcement. Use non-root, `readOnlyRootFilesystem`,
`allowPrivilegeEscalation: false`, dropped capabilities, RuntimeDefault seccomp
and `automountServiceAccountToken: false`. Mount bounded writable `emptyDir`
volumes for scanner temporary files/caches. IRSA's dedicated projected token is
separate from the default Kubernetes service-account token.

The new platform-readiness workflow creates only `kind-bci-egress-lab`, installs
Calico and tests actual IPv4/IPv6 allow/deny behavior plus container restrictions.
It cannot attest an unrelated production cluster. Production preflight takes
`BCI_KUBE_CONTEXT`, `BCI_KUBE_NAMESPACE`, `BCI_KUBE_WORKER_POD`,
`BCI_KUBE_CONTROL_POD`, `BCI_NETWORK_ALLOWED_CANARIES`, and
`BCI_NETWORK_DENIED_CANARIES`. The two canary JSON arrays must each contain
literal IPv4 **and** IPv6 HTTP endpoints at `/bci-network-canary` returning
exactly `BCI_NETWORK_CANARY`. Configure only explicitly owned canaries. Preflight
checks actual pod/policy settings, `/proc` restrictions, allowed worker access,
and denied worker access after an unrestricted control pod proves reachability.
Run this from an operator environment with `kubectl`, the scanner binaries,
Chromium and a narrowly scoped kubeconfig. The application worker needs no
Kubernetes administration rights.

## AWS KMS and CloudHSM

`scripts/cloudhsm-lifecycle.mjs <operation> config.json` supports `plan`,
`provision`, `status`, `csr`, `initialize`, `add-hsms`, `backups`, `copy-backup`
and `restore`. Config: `region`, `name` beginning `bci-`, distinct `subnetIds`
and matching `availabilityZones`, optional `hsmType`, `retentionDays`,
`clusterId`, `sourceBackupId`, `destinationRegion`, `signedCert`, `trustAnchor`.
At least two distinct AZs are required. Preserve the returned cluster ID before
the next operation; provisioning is not a command to repeatedly retry blindly.
Status reports ready only for an ACTIVE cluster with ACTIVE HSMs in two AZs.
CSR export contains the public CSR only. Operator CA signing, crypto-officer
activation and creation of `kmsuser` require the real CloudHSM client and HSM
credentials; BCI does not invent or report their completion.

Create the custom key store using
`node scripts/kms-lifecycle.mjs provision-hsm-store config.json`, where config
contains `name`, `clusterId`, `trustAnchorFile`, `passwordFile`, `region`.
The password file contains the 7–32 alphanumeric `kmsuser` password and must be
restricted to the operator. Provisioning requires `BCI_CLOUD_PROVISIONING_APPROVED=1`.
Poll CONNECTED and run a tenant-bound encrypt/decrypt canary before admission.
`kms-lifecycle.mjs provision alias/bci-pentest-...` creates the credential key;
existing aliases are refused before allocating another key.
Set `BCI_PENTEST_KMS_KEY_ID`, `AWS_REGION` and, for HSM key creation,
`BCI_KMS_CUSTOM_KEY_STORE_ID`. AWS-managed-origin keys use 90-day automatic
rotation. CloudHSM custom-store keys require a replacement key and transactional
account rewrap; automatic rotation is refused for them. Retain old keys until
all ciphertext and recovery backups have been migrated and tested.

Operator permissions include the specific CloudHSM cluster/HSM initialization,
describe/list/tag, backup-copy actions; KMS custom-store create/connect/describe,
key/alias creation and rotation; and IAM role/trust/inline-policy administration.
The runtime plan contains no such administration grants. Private subnets,
security-group connectivity, the operator CA, HSM activation and the AWS account
must already be real and authorized.

## Immutable evidence, timestamps and independent verification

Use `node scripts/s3-lifecycle.mjs plan|provision config.json`; config contains
`accountId`, `region`, `name`, distinct `archiveBucket`, `checkpointBucket`, and
`keyArn`. Provisioning verifies ownership tags for existing buckets and enables
versioning, Object Lock COMPLIANCE, SSE-KMS, owner-enforced ownership, public
access blocks and TLS/key-bound writes. No resource is deleted after a partial
failure. Inspect CloudTrail and returned resource IDs before retrying.
The operator needs bucket create/tag/readiness/versioning/encryption/Object Lock,
ownership/public-access/policy permissions. Runtime permissions remain narrower.

Set `BCI_EVIDENCE_WORM_BUCKET`, `BCI_EVIDENCE_CHECKPOINT_BUCKET`,
`BCI_EVIDENCE_S3_KMS_KEY_ID`, `AWS_REGION`, and
`BCI_EVIDENCE_COMPLIANCE_APPROVED=1`. Retention defaults to 365 days; configure
`BCI_EVIDENCE_RETENTION_DAYS` and optionally a smaller
`BCI_EVIDENCE_MAX_RETENTION_DAYS`. The hard maximum is 2555 days. COMPLIANCE
retention is irreversible until expiry; it is never silently weakened.
The SDK supplies the tenant evidence encryption context and checks the returned
object version and retention. A checkpoint is separately signed, sequenced and
written to a different locked bucket. Independent verification reads that store,
verifies signatures, continuity and live retention, then compares the trusted
tail with the exported report. Use a separately administered read identity:
`node scripts/verify-external-checkpoint.mjs report.json <org UUID> <job UUID>`.
The authenticated UI/API can also request this verification; unavailable
providers return an explicit unavailable result, not a verification success.

For the external TSA set `BCI_EVIDENCE_TSA_URL`,
`BCI_EVIDENCE_TSA_CA_FILE`, and, for a private HTTPS CA,
`NODE_EXTRA_CA_CERTS`. `BCI_OPENSSL_BIN` may select the real OpenSSL executable.
The response certificate chain, request digest and nonce are actually checked.
Sign evidence using `BCI_PENTEST_EVIDENCE_PRIVATE_KEY`; keep the historical
`BCI_PENTEST_EVIDENCE_PUBLIC_KEYS` JSON map keyed by SHA256 of SPKI DER.
Missing/unreachable providers remain NOT_CONFIGURED/FAILED in the report.

## Database and rollout

Apply migrations through `0049_pentest_authentication_safety.sql` before starting
new workers. It is additive; the integration test also queries the previous
engagement columns after restoration. Roll back the application image first;
do not drop budgets or evidence tables to roll back a deployment. A SQL
transaction rollback and old-column query are tested, not an unperformed
production image rollback.

`node scripts/database-recovery.mjs backup /restricted/backup.dump` creates a
new mode-0600 custom-format archive and returns its SHA256. It refuses overwrite.
Store that digest outside the backup's write boundary. Restore using
`node scripts/database-recovery.mjs restore /restricted/backup.dump <trusted SHA256>`
against an explicitly empty isolated `BCI_DATABASE_URL`. Digest/header checks,
empty-destination checks and single-transaction restore are mandatory; the shell
wrappers use the same implementation. Connection secrets use libpq environment
fields, never command-line arguments. Match pg_dump/pg_restore to the server's
major version. Worker builds default to PostgreSQL client 16 to match compose;
set `POSTGRES_CLIENT_MAJOR` for a different deployed server. Configure
`BCI_PG_DUMP_BIN`/`BCI_PG_RESTORE_BIN` for standalone operator tools.
Backups do not contain external KMS/HSM/Vault keys or the evidence signing
private key; preserve their separate recovery material and historical public
keys. A database-only restore is not proof of external key recovery.

Run `node scripts/preflight.mjs` from the prepared operator environment. KMS
canaries also need `BCI_PREFLIGHT_TENANT_ID` or `BCI_WORKER_ORG_ID` matching IAM.
The independent S3 write/read/retention checkpoint canary requires
`BCI_PREFLIGHT_CLOUD_CANARY_APPROVED=1` and `BCI_PREFLIGHT_TENANT_ID`: it creates
two real retained objects. Metadata-only bucket access is not sufficient to
pass this check. Missing approval is BLOCKED; no canary write is attempted.
Missing configuration is BLOCKED with exact variable names and a nonzero exit;
actual failed checks are FAIL. Neither category admits production.

## Reproducible provider tests

For an isolated actual Vault executable, set `BCI_PROVIDER_LAB=1` and
`BCI_VAULT_BIN`, then run `node scripts/run-vault-lab.mjs`. It starts a fresh
TLS dev server on loopback, tests real Transit/AppRole/backup/rotation and TLS
RFC3161 behavior, then removes only its own temporary service and files.
No real cloud success is inferred from that local service.

Live AWS tests additionally require `BCI_PROVIDER_AWS_LAB=1`, an explicit
`BCI_PREFLIGHT_TENANT_ID`, the KMS/S3 configuration above, actual runtime AWS
credentials and a separate replacement `BCI_PENTEST_KMS_ROTATION_TEST_KEY_ID`
to verify real cross-key rewrap. They also require
two dedicated buckets beginning `bci-lab-`. They create real
retained canary objects only after COMPLIANCE approval is configured. Without
these prerequisites the two AWS tests are skipped and must not be counted as
passing. No AWS account credentials or profiles were available in this delivery
environment; no CloudHSM/KMS/S3 deployment has been claimed.
