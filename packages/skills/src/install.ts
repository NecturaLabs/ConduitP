import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function install(): void {
  const homeDir = homedir();
  const claudeDir = join(homeDir, '.claude');
  const skillsDir = join(claudeDir, 'skills', 'conduit');

  // Create skills directory
  mkdirSync(skillsDir, { recursive: true });

  // Copy setup skill
  const skillSrc = join(__dirname, '..', 'skills', 'conduit-setup.md');
  const skillDst = join(skillsDir, 'conduit-setup.md');
  copyFileSync(skillSrc, skillDst);

  // Read auto-behavior content
  const autoContent = readFileSync(join(__dirname, '..', 'skills', 'conduit-auto.md'), 'utf-8');
  const block = `<!-- conduit:start -->\n${autoContent}\n<!-- conduit:end -->`;

  // Update CLAUDE.md
  const claudeMd = join(claudeDir, 'CLAUDE.md');
  let existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf-8') : '';

  const startMarker = '<!-- conduit:start -->';
  const endMarker = '<!-- conduit:end -->';
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + block + existing.slice(endIdx + endMarker.length);
  } else {
    existing = existing.trimEnd() + (existing ? '\n\n' : '') + block;
  }

  writeFileSync(claudeMd, existing);

  console.log('✓ Conduit skills installed. Run /conduit-setup in Claude Code to complete setup.');
}

install();
