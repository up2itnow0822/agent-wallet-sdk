# AGENTS.md — unity-sdk

## Purpose

- This subtree contains the Unity x402 beta package for `agent-wallet-sdk`.
- It includes the runtime package, sample, EditMode tests, and Docker-runner
  test harness used to verify the Unity integration.

## Ownership

- Bill Wilson (@up2itnow0822) / AI Agent Economy, LLC

## Local Contracts

- Keep the package Unity Package Manager compatible.
- Keep runtime code under `Runtime/`, tests under `Tests/`, the sample under
  `Samples~/`, and disposable verification assets under `TestProject/`.
- Local and Docker-runner verification are the supported test paths. Do not add
  GitHub-hosted CI as the default Unity verification path.
- The Linux 2021.3 editor image requires a real `Unity_lic.ulf` or injected
  `UNITY_LICENSE`. `UnityEntitlementLicense.xml` is not a valid substitute.

## Work Guidance

- Keep README links and package metadata valid against the public repo layout.
- Preserve the injectable transport seam in `X402Client` so EditMode tests can
  verify retry and cap behavior without live network calls.
- Treat `LocalKeySigner` as a development helper, not a production custody
  recommendation.

## Verification

- `bash -n scripts/run-editmode-tests-docker.sh`
- Run Unity EditMode tests locally with the installed editor when available.
- Run `scripts/run-editmode-tests-docker.sh` when a Linux-usable Unity license
  is available for the Docker runner.

## Child DOX Index

<!-- No child AGENTS.md files yet -->
