#!/usr/bin/env node
/* global AbortSignal, console, fetch, process */

const DEFAULT_BAD_ID = 'stenion-smoke-missing-protocol';
const EXPECTED_ERROR = 'Protocol not found';
const TIMEOUT_MS = 10_000;

function printUsage() {
  console.log(`Usage: pnpm smoke:protocol-404 <base-url> [protocol-id]

Smoke-tests the deployed API 404 response for an unknown protocol id.

Examples:
  pnpm smoke:protocol-404 https://stenion.vercel.app
  STENION_SMOKE_BASE_URL=https://stenion.vercel.app pnpm smoke:protocol-404
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
  // pnpm forwards a literal `--` through to the script, so drop it before
  // reading positional arguments — otherwise `pnpm smoke:protocol-404 -- <url>`
  // parses `--` as the base URL and the URL as the protocol id.
  const args = process.argv.slice(2).filter((arg) => arg !== '--');

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

  let response;
  try {
    response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Request to ${endpoint} failed: ${error.message}`);
  }

  // Status first: a wrong base URL (or a dev server, which does not 404 here)
  // answers with HTML, and "got 200" is a far more useful failure than a JSON
  // parse error about an unexpected '<'.
  if (response.status !== 404) {
    throw new Error(`Expected status 404 from ${endpoint}, got ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Expected JSON response from ${endpoint}: ${error.message}`);
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
