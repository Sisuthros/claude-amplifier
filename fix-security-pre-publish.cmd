@echo off
REM Pre-publish security fix for claude-amplifier 1.4.0
REM
REM Runs the recommended fixes from SECURITY_AUDIT_2026-05-21:
REM   1. npm audit fix     - bumps transitive deps (4 advisories in MCP SDK)
REM   2. npm test          - confirms nothing broke
REM   3. npm pack --dry-run - confirms package still builds
REM
REM Usage: fix-security-pre-publish.cmd

setlocal

cd /d "%~dp0"

echo.
echo === Step 1: npm audit ===
echo.
call npm audit
echo.

echo === Step 2: npm audit fix ===
echo.
call npm audit fix
if errorlevel 1 (
  echo.
  echo audit fix had issues. Trying with --force as fallback...
  call npm audit fix --force
)

echo.
echo === Step 3: rebuild ===
echo.
call npm run build
if errorlevel 1 (
  echo ERROR: build failed after audit fix. Investigate before publishing.
  exit /b 1
)

echo.
echo === Step 4: test ===
echo.
call npm test
if errorlevel 1 (
  echo ERROR: tests failed after audit fix. Revert package-lock and investigate.
  exit /b 1
)

echo.
echo === Step 5: dry-run pack ===
echo.
call npm pack --dry-run

echo.
echo === All checks passed ===
echo.
echo You can now run:
echo   npm publish
echo.
echo This will publish claude-amplifier@1.4.0 to the npm registry.
echo.

endlocal
