#!/usr/bin/env node
/**
 * Computes SHA-256 hashes of all inline <script> blocks found in the
 * Next.js static export output (apps/landing/out/**\/*.html) and prints
 * the full set of 'sha256-...' tokens to stdout, space-separated.
 *
 * Called by build-netlify.sh AFTER `next build` but BEFORE the Vite SPA is
 * merged into apps/landing/out/app/ — so only landing-page HTML is scanned.
 *
 * The union of hashes across all pages is used in the /*  header rule.
 * This is slightly broader than per-page CSP but is safe for a static
 * marketing site and avoids the complexity of per-path header rules.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function extractHashes(html) {
  const hashes = new Set();
  for (const [, attrs, content] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/\btype\s*=\s*["']application\//.test(attrs)) continue;
    if (!content.trim()) continue;
    const hash = createHash('sha256').update(content, 'utf-8').digest('base64');
    hashes.add(`'sha256-${hash}'`);
  }
  return hashes;
}

function findHtml(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findHtml(p));
    else if (entry.name.endsWith('.html')) files.push(p);
  }
  return files;
}

// Resolve relative to this file so the script works regardless of cwd.
const LANDING_OUT = fileURLToPath(new URL('../apps/landing/out', import.meta.url));
const allHashes = new Set();

for (const f of findHtml(LANDING_OUT)) {
  for (const h of extractHashes(readFileSync(f, 'utf-8'))) {
    allHashes.add(h);
  }
}

if (allHashes.size === 0) {
  process.stderr.write('[csp] ERROR: No inline scripts found in landing HTML — cannot build hash-based CSP. Aborting.\n');
  process.exit(1);
}

process.stderr.write(`[csp] Found ${allHashes.size} unique inline script hash(es) across landing pages\n`);
process.stdout.write([...allHashes].join(' '));
