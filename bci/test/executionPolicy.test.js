import { describe, it, expect, beforeEach } from 'vitest';
import { decideExecutionMode, getQuantumPolicy, setQuantumPolicy } from '../src/quantum/executionPolicy.js';
import { COMPUTE_MODES, PROVIDER_HEALTH } from '../src/quantum/QuantumComputeGateway.js';
import { resetDatabase, createOrg } from './helpers/db.js';

const AVAILABLE = { status: PROVIDER_HEALTH.AVAILABLE };
const NOT_CONFIGURED = { status: PROVIDER_HEALTH.NOT_CONFIGURED };

const DENY_ALL_POLICY = { allowQuantumSimulator: false, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' };
const SIM_ONLY_POLICY = { allowQuantumSimulator: true, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' };
const HARDWARE_POLICY = { allowQuantumSimulator: true, allowQuantumHardware: true, maxExternalDataClassification: 'CONFIDENTIAL' };

describe('decideExecutionMode (pure) — spec section 7', () => {
  it('defaults to CLASSICAL when the org has never opted into quantum', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('org_policy_denies_quantum');
  });

  it('uses the simulator once policy allows it and it is healthy and the problem fits', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: SIM_ONLY_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: NOT_CONFIGURED },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_SIMULATOR);
  });

  // Explicitly marking quantum_inspired UNAVAILABLE here (rather than
  // omitting it) makes clear these two are testing "nothing at all is
  // usable, all the way down the chain" -- not accidentally passing
  // because a lower rung was never checked.
  it('falls back to CLASSICAL when the simulator is NOT_CONFIGURED and quantum-inspired is also unavailable', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: SIM_ONLY_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: { status: PROVIDER_HEALTH.UNAVAILABLE } },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
  });

  it('falls back to CLASSICAL when the problem exceeds both the simulator and quantum-inspired ceilings', () => {
    const decision = decideExecutionMode({
      problemSize: 1000, policy: SIM_ONLY_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: NOT_CONFIGURED, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
  });

  // The fallback chain this whole test suite exists to enforce (spec
  // section 6): IBM HARDWARE -> LOCAL SIMULATOR -> QUANTUM-INSPIRED ->
  // CLASSICAL. Quantum-inspired must be tried before giving up to
  // classical, not skipped straight past.
  it('falls back to QUANTUM_INSPIRED (not straight to CLASSICAL) when the simulator is unavailable but quantum-inspired is healthy', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: SIM_ONLY_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_INSPIRED);
    expect(decision.reason).toBe('simulator_not_configured');
  });

  it('falls back to QUANTUM_INSPIRED when IBM hardware is unavailable and the simulator is also unavailable', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: { status: PROVIDER_HEALTH.UNAVAILABLE }, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_INSPIRED);
  });

  it('uses IBM hardware when policy allows it, data classification permits, and it is available', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
  });

  it('SECRET data never reaches external IBM hardware even if the org policy allows quantum hardware generally', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'SECRET',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).not.toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_SIMULATOR); // stays local instead
    expect(decision.reason).toBe('data_classification_denies_external_quantum');
  });

  it('falls back from IBM to the simulator (not straight to an error) when IBM is unavailable', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: { status: PROVIDER_HEALTH.UNAVAILABLE } },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_SIMULATOR);
  });

  it('the CLASSICAL fallback reason names quantum-inspired specifically when even that is unavailable', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: SIM_ONLY_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: { status: PROVIDER_HEALTH.UNAVAILABLE } },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('quantum_inspired_unavailable');
  });

  it('a byte-identical call with no preferredMode behaves exactly as before this parameter existed', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
  });

  it('preferredMode=CLASSICAL returns immediately, never touching the quantum chain at all', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
      preferredMode: COMPUTE_MODES.CLASSICAL,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('user_selected_classical');
  });

  it('preferredMode=QUANTUM_SIMULATOR skips hardware even though policy allows and it is healthy', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
      preferredMode: COMPUTE_MODES.QUANTUM_SIMULATOR,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_SIMULATOR);
    expect(decision.reason).toBe('user_selected_simulator_skips_hardware');
  });

  it('preferredMode=QUANTUM_SIMULATOR still cascades to QUANTUM_INSPIRED when the simulator itself is unavailable (real fallback, not a hard stop)', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: AVAILABLE, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
      preferredMode: COMPUTE_MODES.QUANTUM_SIMULATOR,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_INSPIRED);
  });

  it('preferredMode=QUANTUM_HARDWARE is the same as no preference at all (top of the chain)', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'INTERNAL',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
      preferredMode: COMPUTE_MODES.QUANTUM_HARDWARE,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
  });

  it('preferredMode never bypasses org policy -- a preference for hardware still falls through when policy denies quantum entirely', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
      preferredMode: COMPUTE_MODES.QUANTUM_HARDWARE,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('org_policy_denies_quantum');
  });

  // Regression test for a real bug found in production code review: the
  // org-policy short-circuit above (both allowQuantumSimulator and
  // allowQuantumHardware false -> immediate CLASSICAL) used to run BEFORE
  // the preferredMode===QUANTUM_INSPIRED check, so an explicit user
  // selection of the local, policy-independent quantum-inspired provider
  // was silently overridden to CLASSICAL by a policy gate that only ever
  // governs EXTERNAL quantum (simulator/hardware). Quantum-inspired never
  // leaves the machine, so it must run here.
  it('preferredMode=QUANTUM_INSPIRED runs even when org policy denies both simulator and hardware (regression)', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
      preferredMode: COMPUTE_MODES.QUANTUM_INSPIRED,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.QUANTUM_INSPIRED);
    expect(decision.reason).toBe('user_selected_quantum_inspired');
  });

  it('preferredMode=QUANTUM_INSPIRED still falls back to CLASSICAL when quantum-inspired itself is unhealthy, policy denying quantum entirely', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: { status: PROVIDER_HEALTH.UNAVAILABLE } },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
      preferredMode: COMPUTE_MODES.QUANTUM_INSPIRED,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('quantum_inspired_unavailable');
  });

  it('preferredMode=QUANTUM_INSPIRED still falls back to CLASSICAL when the problem exceeds the quantum-inspired size ceiling', () => {
    const decision = decideExecutionMode({
      problemSize: 1000, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: { quantum_simulator: NOT_CONFIGURED, ibm_quantum: NOT_CONFIGURED, quantum_inspired: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12, quantumInspiredMaxSize: 500,
      preferredMode: COMPUTE_MODES.QUANTUM_INSPIRED,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('problem_too_large_for_quantum_inspired');
  });

  it('preferredMode=CLASSICAL always executes CLASSICAL regardless of quantum policy (independent compute mode)', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: DENY_ALL_POLICY, dataClassification: 'PUBLIC',
      providerHealthById: {},
      simulatorMaxSize: 10, hardwareMaxSize: 12,
      preferredMode: COMPUTE_MODES.CLASSICAL,
    });
    expect(decision.mode).toBe(COMPUTE_MODES.CLASSICAL);
    expect(decision.reason).toBe('user_selected_classical');
  });

  it('an unrecognized data classification fails closed (never treated as low-sensitivity)', () => {
    const decision = decideExecutionMode({
      problemSize: 4, policy: HARDWARE_POLICY, dataClassification: 'NOT_A_REAL_CLASSIFICATION',
      providerHealthById: { quantum_simulator: AVAILABLE, ibm_quantum: AVAILABLE },
      simulatorMaxSize: 10, hardwareMaxSize: 12,
    });
    expect(decision.mode).not.toBe(COMPUTE_MODES.QUANTUM_HARDWARE);
  });
});

describe('quantum policy persistence', () => {
  beforeEach(resetDatabase);

  it('defaults to the safe/local-only posture when an org has never set a policy', async () => {
    const orgId = await createOrg();
    const policy = await getQuantumPolicy(orgId);
    expect(policy).toEqual({ allowQuantumSimulator: false, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' });
  });

  it('round-trips a policy update', async () => {
    const orgId = await createOrg();
    await setQuantumPolicy(orgId, { allowQuantumSimulator: true, allowQuantumHardware: false, maxExternalDataClassification: 'INTERNAL' });
    const policy = await getQuantumPolicy(orgId);
    expect(policy.allowQuantumSimulator).toBe(true);
    expect(policy.maxExternalDataClassification).toBe('INTERNAL');
  });
});
