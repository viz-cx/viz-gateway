#!/usr/bin/env node
// tools/keystore.cjs
//
// Seal the operator's raw secret material into a passphrase-protected keystore so
// no plaintext WIF / mnemonic / Solana secret sits on disk or in a .env file, and
// verify an existing keystore opens. This is the local at-rest custody mitigation
// from the 2026-07-06 decision (keys stay on-box, federation is the custody
// control, HSM/KMS not planned — see docs/AUDIT.md §8).
//
// Build first (`npm run build`); the crypto lives in @gateway/common/keystore.
//
// Usage:
//   # Seal: takes secrets from the env, writes the sealed file. Prompts for a passphrase (twice).
//   VIZ_SIGNING_WIF=... GRAM_SIGNER_MNEMONIC="..." SOLANA_SIGNER_SECRET="[1,2,...]" \
//     node tools/keystore.cjs seal ./keystore.json
//
//   # Verify: opens the file and reports which fields are present (never prints values).
//   node tools/keystore.cjs verify ./keystore.json
//
// Then run services with:  FED_KEYSTORE=./keystore.json FED_KEYSTORE_PASSPHRASE=... npm run start:signer
// (or omit the passphrase env to be prompted on a TTY).
'use strict';

const fs = require('node:fs');
const { sealKeystore, openKeystore, constantTimeEqual } = require('@gateway/common');

/** Read a line from the TTY with echo disabled (best-effort). */
function promptHidden(prompt) {
  const { execFileSync } = require('node:child_process');
  process.stderr.write(prompt);
  try {
    execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
  } catch {
    /* no tty control; input may echo */
  }
  try {
    const fd = fs.openSync('/dev/tty', 'rs');
    try {
      const buf = Buffer.alloc(1);
      let line = '';
      while (fs.readSync(fd, buf, 0, 1, null) === 1) {
        const ch = buf.toString('utf8');
        if (ch === '\n' || ch === '\r') break;
        line += ch;
      }
      return line;
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    try {
      execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
    } catch {
      /* ignore */
    }
    process.stderr.write('\n');
  }
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function collectSecretsFromEnv() {
  const secrets = {};
  if (process.env.VIZ_SIGNING_WIF) secrets.vizSigningWif = process.env.VIZ_SIGNING_WIF;
  if (process.env.GRAM_SIGNER_MNEMONIC) secrets.gramSignerMnemonic = process.env.GRAM_SIGNER_MNEMONIC;
  if (process.env.SOLANA_SIGNER_SECRET) secrets.solanaSignerSecret = process.env.SOLANA_SIGNER_SECRET;
  return secrets;
}

function cmdSeal(outPath) {
  if (!outPath) die('seal: output path required (e.g. node tools/keystore.cjs seal ./keystore.json)');
  if (fs.existsSync(outPath)) die(`seal: refusing to overwrite existing file ${outPath}`);

  const secrets = collectSecretsFromEnv();
  const fields = Object.keys(secrets);
  if (fields.length === 0) {
    die('seal: no secrets found in env (set VIZ_SIGNING_WIF / GRAM_SIGNER_MNEMONIC / SOLANA_SIGNER_SECRET)');
  }
  console.error(`sealing ${fields.length} secret(s): ${fields.join(', ')}`);

  const pass = process.env.FED_KEYSTORE_PASSPHRASE || promptHidden('New keystore passphrase: ');
  if (!pass) die('seal: empty passphrase');
  if (!process.env.FED_KEYSTORE_PASSPHRASE) {
    const confirm = promptHidden('Confirm passphrase: ');
    if (!constantTimeEqual(pass, confirm)) die('seal: passphrases do not match');
  }

  const ks = sealKeystore(secrets, pass);
  // 0600 — owner read/write only; the whole point is nothing readable at rest.
  fs.writeFileSync(outPath, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  console.error(`wrote sealed keystore -> ${outPath} (mode 0600)`);
}

function cmdVerify(inPath) {
  if (!inPath) die('verify: keystore path required');
  if (!fs.existsSync(inPath)) die(`verify: no such file ${inPath}`);

  const pass = process.env.FED_KEYSTORE_PASSPHRASE || promptHidden(`Passphrase for ${inPath}: `);
  if (!pass) die('verify: empty passphrase');

  let secrets;
  try {
    secrets = openKeystore(JSON.parse(fs.readFileSync(inPath, 'utf8')), pass);
  } catch (e) {
    die(`verify: ${e.message}`);
  }
  const present = Object.keys(secrets);
  console.error(`OK: keystore opens. fields present: ${present.length ? present.join(', ') : '(none)'}`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'seal':
    cmdSeal(arg);
    break;
  case 'verify':
    cmdVerify(arg);
    break;
  default:
    console.error('usage: node tools/keystore.cjs <seal|verify> <path>');
    process.exit(1);
}
