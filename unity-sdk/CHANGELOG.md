# Changelog

## [Unreleased]

### Added for testing

- Unity EditMode tests for x402 retry behavior, body/header requirement parsing,
  and fail-closed spending caps
- Local Docker runner script plus minimal Unity test project for package-level
  verification without GitHub CI

### Changed for testability

- `X402Client` now accepts an injectable transport so request/retry behavior can
  be verified deterministically while preserving the UnityWebRequest default at
  runtime
- `X402Client` now recovers decimal payment amounts from raw x402 JSON because
  Unity's `JsonUtility` leaves decimal fields at `0`
- `run-editmode-tests-docker.sh` now avoids Unity's `-quit` test-run trap,
  runs EditMode tests synchronously, and rejects
  `UnityEntitlementLicense.xml` with explicit guidance to supply a real ULF

## [1.0.0] - 2026-03-15

### Initial release

- Core `X402Client` with automatic HTTP 402 payment handling
- `X402AgentBehaviour` MonoBehaviour for drag-and-drop NPC wallet integration
- `IX402Signer` interface for pluggable wallet backends
- `LocalKeySigner` for development and testing
- `X402Config` with session spending limits and per-payment caps
- Payment history tracking and session spend monitoring
- Basic Payment sample scene
- Unity Package Manager (UPM) compatible package structure
