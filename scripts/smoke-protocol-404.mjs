#!/usr/bin/env node

const DEFAULT_BAD_ID = 'stenion-smoke-missing-protocol';
const EXPECTED_ERROR = 'Protocol not found';

function printUsage() {
  console.log(`Usage: pnpm smoke:protocol-404 -- <base-url> [protocol-id]

Smoke-tests the deployed API 404 response for an unknown protocol id.

Examples:
  pnpm smoke:protocol-404 -- https://stenion.com
  STENION_SMOKE_BASE_URL=https://stenion.com pnpm smoke:protocol-404
`);
}

function normalizeBaseUrl(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, '');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const baseUrl = normalizeBaseUrl(args[0] ?? process.env.STENION_SMOKE_BASE_URL);
  const protocolId = args[1] ?? process.env.STENION_SMOKE_PROTOCOL_ID ?? DEFAULT_BAD_ID;

  if (!baseUrl) {
    console.error('Missing deployed base URL.');
    printUsage();
    process.exitCode = 2;
    return;
  }

  const endpoint = `${baseUrl}/api/v1/protocol/${encodeURIComponent(protocolId)}`;
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
  });

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Expected JSON response from ${endpoint}: ${error.message}`);
  }

  if (response.status !== 404) {
    throw new Error(`Expected status 404 from ${endpoint}, got ${response.status}`);
  }

  if (body?.error !== EXPECTED_ERROR || body?.id !== protocolId) {
    throw new Error(
      `Expected body ${JSON.stringify({ error: EXPECTED_ERROR, id: protocolId })}, got ${JSON.stringify(body)}`,
    );
  }

  console.log(`OK: ${endpoint} returned 404 with the documented error body.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
