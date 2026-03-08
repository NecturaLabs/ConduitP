#!/usr/bin/env bash
set -euo pipefail

echo "Building landing page..."
cd apps/landing && bun run build && cd ../..

# Compute SHA-256 hashes of all inline <script> blocks in the Next.js static
# export HTML. Done HERE — before the Vite SPA is merged into out/app/ — so
# findHtml() only sees landing HTML, not the dashboard's index.html.
# The script exits 1 if no hashes are found, failing the build loudly.
echo "Computing landing page CSP hashes..."
LANDING_SCRIPT_HASHES=$(node scripts/compute-landing-csp.mjs)
LANDING_SCRIPT_SRC="'self' ${LANDING_SCRIPT_HASHES} https://static.cloudflareinsights.com"

echo "Building dashboard..."
cd apps/web && bun run build && cd ../..

echo "Merging outputs..."
# Next.js static export goes to apps/landing/out/
# Vite build goes to apps/web/dist/
# Copy Vite dist into landing out/app/
mkdir -p apps/landing/out/app
cp -r apps/web/dist/* apps/landing/out/app/

# Write a _redirects file so Netlify rewrites /app/* to the Vite SPA index.
# This runs before the 404.html catch-all and returns a 200 status.
echo "/app/*  /app/index.html  200" > apps/landing/out/_redirects

# Derive the API origin (scheme + host, no path) from VITE_API_URL so it can
# be added to connect-src. Falls back to empty string if not set (dev builds).
API_ORIGIN=""
if [ -n "${VITE_API_URL:-}" ]; then
  # Strip path — keep scheme://host[:port] only
  API_ORIGIN=$(echo "$VITE_API_URL" | sed 's|^\(https\?://[^/]*\).*|\1|')
fi

# Write a _headers file for security headers (works with API deploys too).
# netlify.toml [[headers]] only applies when Netlify builds the site itself;
# for CI-driven deploys via the Netlify API this _headers file is required.
#
# IMPORTANT: This heredoc uses an unquoted delimiter (HEADERS, not 'HEADERS')
# so that shell variables like ${API_ORIGIN} and ${LANDING_SCRIPT_SRC} expand.
# All static header values are safe (no $ characters). When editing this
# heredoc, avoid introducing values that contain $ — use printf for any
# additional dynamic lines instead.
cat > apps/landing/out/_headers << HEADERS
/app/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-XSS-Protection: 0
  Content-Security-Policy: default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ${API_ORIGIN} https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload

/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-XSS-Protection: 0
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  Content-Security-Policy: default-src 'self'; script-src ${LANDING_SCRIPT_SRC}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ${API_ORIGIN} https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';

/app/assets/*
  Cache-Control: public, max-age=31536000, immutable

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

echo "Build complete! Publish directory: apps/landing/out"
