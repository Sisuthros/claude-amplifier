@echo off
REM Vercel deploy helper for claude-amplifier landing page.
REM
REM Prerequisites:
REM   1. Node 18+ installed
REM   2. Vercel CLI installed (auto-installed by npx on first run)
REM   3. Logged in to Vercel: `npx vercel login` (one-time)
REM
REM Usage: deploy.cmd

setlocal

echo.
echo === claude-amplifier site deploy ===
echo.
echo Checking prerequisites...
where node >nul 2>&1 || (echo ERROR: Node.js not found in PATH. & exit /b 1)
where npx >nul 2>&1 || (echo ERROR: npx not found in PATH. & exit /b 1)

echo Node OK. Deploying to Vercel production...
echo.
echo If this is the first run:
echo   - Choose "Set up and deploy"
echo   - Select scope: your-username
echo   - Link to existing project? No (first time)
echo   - Project name: claude-amplifier-site
echo   - Directory: ./
echo   - Framework: Other (static)
echo   - Build command: (leave empty, press Enter)
echo   - Output Directory: ./ (default)
echo.

npx vercel --prod
if errorlevel 1 (
  echo.
  echo Deploy failed. See error above.
  exit /b 1
)

echo.
echo === Done ===
echo.
echo Next steps:
echo   1. Note the production URL printed by Vercel (e.g. claude-amplifier-site.vercel.app)
echo   2. Visit it to verify the page renders
echo   3. To attach custom domain:
echo        - Buy claude-amplifier.dev (Namecheap/Porkbun/Cloudflare ~13 USD/yr)
echo        - Vercel dashboard - Settings - Domains - Add Domain
echo        - Follow DNS instructions
echo.

endlocal
