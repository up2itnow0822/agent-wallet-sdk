#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_PACKAGE_ROOT="/workspace/unity-sdk"
CONTAINER_PROJECT_PATH="${CONTAINER_PACKAGE_ROOT}/TestProject"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${TMP_ROOT}/agentwallet-x402-editmode}"
UNITY_EDITOR_IMAGE="${UNITY_EDITOR_IMAGE:-unityci/editor:ubuntu-2021.3.0f1-base-3}"
RUN_ROOT="$(mktemp -d "${TMP_ROOT}/agentwallet-x402-run.XXXXXX")"
PACKAGE_COPY_ROOT="${RUN_ROOT}/package"
PROJECT_COPY_ROOT="${RUN_ROOT}/TestProject"
CONTAINER_PACKAGE_COPY_ROOT="/workspace/package"
CONTAINER_PROJECT_COPY_ROOT="/workspace/TestProject"
DEFAULT_LICENSE_CANDIDATES=(
  "/Library/Application Support/Unity/Unity_lic.ulf"
  "${HOME}/.local/share/unity3d/Unity/Unity_lic.ulf"
)

mkdir -p "${ARTIFACTS_DIR}"

cleanup() {
  if [[ -d "${RUN_ROOT:-}" ]]; then
    rm -rf "${RUN_ROOT}"
  fi
  if [[ -n "${TEMP_LICENSE_DIR:-}" && -d "${TEMP_LICENSE_DIR}" ]]; then
    rm -rf "${TEMP_LICENSE_DIR}"
  fi
}
trap cleanup EXIT

hydrate_from_launchctl() {
  local name="$1"
  if [[ -n "${!name:-}" ]] || ! command -v launchctl >/dev/null 2>&1; then
    return 0
  fi

  local value
  value="$(launchctl getenv "${name}" 2>/dev/null || true)"
  if [[ -n "${value}" ]]; then
    printf -v "${name}" '%s' "${value}"
    export "${name}"
  fi
}

hydrate_from_launchctl "UNITY_LICENSE_FILE"
hydrate_from_launchctl "UNITY_LICENSE"
hydrate_from_launchctl "UNITY_EMAIL"
hydrate_from_launchctl "UNITY_PASSWORD"

if [[ -n "${UNITY_LICENSE_FILE:-}" ]]; then
  LICENSE_FILE="${UNITY_LICENSE_FILE}"
elif [[ -n "${UNITY_LICENSE:-}" ]]; then
  TEMP_LICENSE_DIR="$(mktemp -d)"
  LICENSE_FILE="${TEMP_LICENSE_DIR}/Unity_lic.ulf"
  printf '%s' "${UNITY_LICENSE}" > "${LICENSE_FILE}"
else
  for candidate in "${DEFAULT_LICENSE_CANDIDATES[@]}"; do
    if [[ -f "${candidate}" ]]; then
      LICENSE_FILE="${candidate}"
      break
    fi
  done
fi

if [[ -z "${LICENSE_FILE:-}" ]]; then
  cat >&2 <<'EOF'
Unity license material not found.

Provide one of:
- UNITY_LICENSE_FILE=/absolute/path/to/Unity_lic.ulf
- UNITY_LICENSE='<full license file contents>'

Or activate Unity Hub locally first. The script auto-detects the default file
paths on:
- macOS: /Library/Application Support/Unity/Unity_lic.ulf
- Linux: ~/.local/share/unity3d/Unity/Unity_lic.ulf
EOF
  exit 1
fi

if [[ ! -f "${LICENSE_FILE}" ]]; then
  echo "Unity license file not found: ${LICENSE_FILE}" >&2
  exit 1
fi

if grep -q "EntitlementGroup" "${LICENSE_FILE}" 2>/dev/null; then
  cat >&2 <<EOF
Unity entitlement XML detected at: ${LICENSE_FILE}

This Docker runner needs a Hub-created ULF license file for the Linux editor
image, not UnityEntitlementLicense.xml from the local macOS entitlement store.
Provide UNITY_LICENSE_FILE pointing at Unity_lic.ulf or inject UNITY_LICENSE
with the full ULF contents.
EOF
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run Unity EditMode tests." >&2
  exit 1
fi

cp -R "${PACKAGE_ROOT}" "${PACKAGE_COPY_ROOT}"
rm -rf "${PACKAGE_COPY_ROOT}/TestProject"

cp -R "${PACKAGE_ROOT}/TestProject" "${PROJECT_COPY_ROOT}"
rm -rf \
  "${PROJECT_COPY_ROOT}/Library" \
  "${PROJECT_COPY_ROOT}/Logs" \
  "${PROJECT_COPY_ROOT}/Temp" \
  "${PROJECT_COPY_ROOT}/obj" \
  "${PROJECT_COPY_ROOT}/UserSettings"
rm -f "${PROJECT_COPY_ROOT}/Packages/packages-lock.json"

perl -0pi -e 's#"com\.agentwallet\.x402":\s*"file:\.\./\.\."#"com.agentwallet.x402": "file:../../package"#' \
  "${PROJECT_COPY_ROOT}/Packages/manifest.json"

# The Unity test runner exits the editor itself; passing -quit short-circuits
# command-line test execution on the bundled com.unity.test-framework.
docker run --rm \
  -v "${PACKAGE_COPY_ROOT}:${CONTAINER_PACKAGE_COPY_ROOT}" \
  -v "${PROJECT_COPY_ROOT}:${CONTAINER_PROJECT_COPY_ROOT}" \
  -v "${ARTIFACTS_DIR}:/workspace/artifacts" \
  -v "${LICENSE_FILE}:/root/.local/share/unity3d/Unity/Unity_lic.ulf:ro" \
  -w "${CONTAINER_PROJECT_COPY_ROOT}" \
  "${UNITY_EDITOR_IMAGE}" \
  /opt/unity/Editor/Unity \
    -batchmode \
    -nographics \
    -projectPath "${CONTAINER_PROJECT_COPY_ROOT}" \
    -runTests \
    -runSynchronously \
    -testPlatform EditMode \
    -testResults /workspace/artifacts/editmode-results.xml \
    -logFile /workspace/artifacts/editmode.log

printf 'EditMode test results: %s\n' "${ARTIFACTS_DIR}/editmode-results.xml"
printf 'Unity log: %s\n' "${ARTIFACTS_DIR}/editmode.log"
