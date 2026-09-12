#!/usr/bin/env node
// Generates the Ed25519 keypair used to sign/verify Offline Intelligence
// Bundles (spec section 53). Run this ONCE per organization, on the
// machine that will run `bundle-export.js` -- the private key never
// leaves it. Distribute only the .pub file to Sovereign/air-gapped
// instances (BCI_BUNDLE_PUBLIC_KEY_PATH).
import { writeFileSync, existsSync } from 'node:fs';
import { generateBundleKeyPair } from '../src/intelligence/bundleSigning.js';

const privatePath = process.argv[2] || 'bundle-signing-key.pem';
const publicPath = process.argv[3] || 'bundle-verify-key.pub.pem';

if (existsSync(privatePath) || existsSync(publicPath)) {
  console.error(`Refusing to overwrite existing key file(s): ${privatePath}, ${publicPath}`);
  process.exit(1);
}

const { publicKeyPem, privateKeyPem } = generateBundleKeyPair();
writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
writeFileSync(publicPath, publicKeyPem);

console.log(`Private key (keep secret, never commit): ${privatePath}`);
console.log(`Public key (distribute to air-gapped instances): ${publicPath}`);
