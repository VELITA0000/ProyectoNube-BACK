#!/usr/bin/env bash
# API/update.sh — rebuild and push the Express bundle to the API Lambda.
# Skips npm install for fast iteration. If you added new dependencies, run create.sh again.
#
# The function name is hard-coded to `photo-app-prod-api` because INFRA always
# names the API Lambda `${var.project_name}-${var.environment}-api` and the
# prod stack uses project_name = "photo-app", environment = "prod". Override
# with `API_LAMBDA_FUNCTION_NAME=… bash API/update.sh` if you ever rename it.
#
# Optional:
#   AWS_REGION          Region for the AWS CLI (uses configured default if unset).
set -euo pipefail

API_LAMBDA_FUNCTION_NAME="${API_LAMBDA_FUNCTION_NAME:-photo-app-prod-api}"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: AWS credentials not available. Run 'aws configure' (or set AWS_PROFILE / env vars) and retry."
  exit 1
fi

API_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$API_ROOT/.lambda-build"
ZIP_PATH="$BUILD_DIR/function.zip"

if [[ ! -d "$API_ROOT/node_modules" ]]; then
  echo "node_modules missing — installing dependencies first"
  cd "$API_ROOT"
  npm install
fi

echo "==> npm run bundle:lambda"
cd "$API_ROOT"
npm run bundle:lambda

echo "==> Packaging $ZIP_PATH"
cd "$BUILD_DIR"
rm -f function.zip

# Pick the first available packaging tool: native `zip`, then 7-Zip (in PATH or
# at the default Windows install paths), then PowerShell's Compress-Archive.
# This keeps the script working on Linux / macOS / Git Bash without forcing the
# user to install anything extra on Windows (7-Zip is bundled in most setups,
# Compress-Archive ships with Windows 10+).
ZIP_TOOL=""
if command -v zip >/dev/null 2>&1; then
  ZIP_TOOL="zip"
elif command -v 7z >/dev/null 2>&1; then
  ZIP_TOOL="7z"
elif command -v 7z.exe >/dev/null 2>&1; then
  ZIP_TOOL="7z.exe"
elif [[ -x "/c/Program Files/7-Zip/7z.exe" ]]; then
  ZIP_TOOL="/c/Program Files/7-Zip/7z.exe"
elif [[ -x "/c/Program Files (x86)/7-Zip/7z.exe" ]]; then
  ZIP_TOOL="/c/Program Files (x86)/7-Zip/7z.exe"
elif command -v powershell.exe >/dev/null 2>&1; then
  ZIP_TOOL="powershell"
else
  echo "ERROR: no zip tool found. Install one of:" >&2
  echo "  - zip       (Linux/macOS via your package manager; MSYS2: pacman -S zip)" >&2
  echo "  - 7-Zip     (Windows: https://www.7-zip.org/)" >&2
  echo "  - PowerShell with Compress-Archive (Windows 10+)" >&2
  exit 1
fi

case "$ZIP_TOOL" in
  zip)
    zip -q function.zip index.js
    ;;
  powershell)
    powershell.exe -NoProfile -Command \
      "Compress-Archive -Path 'index.js' -DestinationPath 'function.zip' -Force" >/dev/null
    ;;
  *)
    "$ZIP_TOOL" a -tzip function.zip index.js >/dev/null
    ;;
esac
echo "    Packaged with: $ZIP_TOOL"

# Stay inside $BUILD_DIR and pass `fileb://function.zip` (a RELATIVE path).
# The AWS CLI binary on Windows (aws.exe invoked from Git Bash) cannot read
# Unix-style /d/… paths, so passing the bare filename from the current
# directory sidesteps the entire path-translation problem on every platform.
echo "==> aws lambda update-function-code ($API_LAMBDA_FUNCTION_NAME)"
aws lambda update-function-code \
  --function-name "$API_LAMBDA_FUNCTION_NAME" \
  --zip-file "fileb://function.zip" \
  ${AWS_REGION:+--region "$AWS_REGION"} \
  >/dev/null

echo "Done. API Lambda updated with $ZIP_PATH"
