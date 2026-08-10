// Minimal indexer — build-order step 4.
//
// Runs each adapter on a fixed interval, wraps every run in try/catch, and
// appends the outcome to a JSONL log (and stdout): safetyScore + factors +
// timestamps on success, or a failed marker on error. Deliberately dumb —
// one interval, no retries, no alerting, no backfill. The JSONL file is the
// interim "somewhere durable"; real Postgres storage is step 5 and replaces
// writeRecord, not the run loop.
//
// All configuration comes from validated env (see config.ts) — no silent
// fallbacks for the RPC/Horizon/pool that decide what and where we index.
// Error model matches the Adapter contract: adapters throw, the indexer
// catches per-run so one protocol failing never aborts the cycle or process.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { BlendAdapter } from '@stenion/adapters';
import type { Adapter, ProtocolMetadata, RiskFactorMap } from '@stenion/core';

import { ConfigError, loadConfig, type IndexerConfig } from './config';

/**
 * An adapter bound to its run pipeline. Wrapping each adapter this way keeps
 * its TRawData type internal (an `Adapter<BlendRawData>` is not assignable to
 * `Adapter<unknown>` because computeRiskFactors is contravariant in TRawData),
 * so a heterogeneous list of adapters can share one run loop.
 */
interface IndexTarget {
  metadata: ProtocolMetadata;
  run(): Promise<{ safetyScore: number; factors: RiskFactorMap; computedAt: Date }>;
}

function toTarget<T>(adapter: Adapter<T>): IndexTarget {
  return {
    metadata: adapter.metadata,
    run: async () => {
      const raw = await adapter.fetchRawData();
      const factors = await adapter.computeRiskFactors(raw);
      const result = adapter.score(factors);
      return { safetyScore: result.score, factors: result.factors, computedAt: result.computedAt };
    },
  };
}

type RunRecord =
  | {
      protocolId: string;
      status: 'ok';
      safetyScore: number;
      factors: RiskFactorMap;
      computedAt: string;
      runAt: string;
    }
  | {
      protocolId: string;
      status: 'failed';
      error: string;
      runAt: string;
    };

function writeRecord(outputFile: string, record: RunRecord): void {
  mkdirSync(dirname(outputFile), { recursive: true });
  appendFileSync(outputFile, `${JSON.stringify(record)}\n`);
}

async function runCycle(targets: IndexTarget[], outputFile: string): Promise<void> {
  for (const target of targets) {
    const runAt = new Date().toISOString();
    try {
      const { safetyScore, factors, computedAt } = await target.run();
      writeRecord(outputFile, {
        protocolId: target.metadata.id,
        status: 'ok',
        safetyScore,
        factors,
        computedAt: computedAt.toISOString(),
        runAt,
      });
      console.log(`[${runAt}] ${target.metadata.id}: safetyScore=${safetyScore}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      writeRecord(outputFile, { protocolId: target.metadata.id, status: 'failed', error, runAt });
      console.error(`[${runAt}] ${target.metadata.id}: FAILED — ${error}`);
    }
  }
}

function buildTargets(config: IndexerConfig): IndexTarget[] {
  // poolId is deliberately not configured here — it's a Blend constant the
  // adapter owns (FIXED_POOL_V2), not environment config. Override via the
  // BlendAdapter constructor if a test/testnet pool is ever needed.
  const blend = new BlendAdapter({
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
  });
  return [toTarget(blend)];
}

async function main(): Promise<void> {
  let config: IndexerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `Invalid indexer configuration:\n${err.problems
          .map((p) => `  - ${p}`)
          .join('\n')}\n\nCopy .env.example to .env and fill it in, then retry.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const targets = buildTargets(config);
  console.log(
    `stenion indexer: ${targets.length} target(s), interval ${config.intervalMs}ms, output ${config.outputFile}`,
  );
  await runCycle(targets, config.outputFile);
  if (config.runOnce) return;
  setInterval(() => {
    void runCycle(targets, config.outputFile);
  }, config.intervalMs);
}

void main();
