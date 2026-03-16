#!/usr/bin/env node
/**
 * Standalone A2A Relay Hub
 *
 * Usage:
 *   npx tsx bin/relay.ts [--port 6060] [--api-keys key1,key2]
 *
 * Environment variables:
 *   RELAY_PORT          - WebSocket port (default: 6060)
 *   RELAY_API_KEYS      - Comma-separated list of accepted API keys
 *   RELAY_MAX_QUEUE     - Max queued messages per offline agent (default: 200)
 *   RELAY_RATE_LIMIT    - Max messages per agent per minute (default: 60)
 */

import { RelayHub } from "../src/relay.js";
import type { RelayHubConfig } from "../src/relay.js";

function parseArgs(): Partial<RelayHubConfig> {
  const args = process.argv.slice(2);
  const config: Partial<RelayHubConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
      case "-p":
        config.port = parseInt(args[++i], 10);
        break;
      case "--api-keys":
        config.apiKeys = args[++i].split(",").map((k) => k.trim()).filter(Boolean);
        break;
      case "--max-queue":
        config.maxQueuePerAgent = parseInt(args[++i], 10);
        break;
      case "--rate-limit":
        config.rateLimitPerMinute = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        console.log("A2A Relay Hub");
        console.log("");
        console.log("Options:");
        console.log("  --port, -p <port>       WebSocket port (default: 6060)");
        console.log("  --api-keys <k1,k2,...>  Accepted API keys (default: none, auth disabled)");
        console.log("  --max-queue <n>         Max queued messages per offline agent (default: 200)");
        console.log("  --rate-limit <n>        Max messages per agent per minute (default: 60)");
        console.log("");
        console.log("Environment variables:");
        console.log("  RELAY_PORT, RELAY_API_KEYS, RELAY_MAX_QUEUE, RELAY_RATE_LIMIT");
        process.exit(0);
    }
  }

  // Environment variable overrides
  if (!config.port && process.env.RELAY_PORT) {
    config.port = parseInt(process.env.RELAY_PORT, 10);
  }
  if (!config.apiKeys && process.env.RELAY_API_KEYS) {
    config.apiKeys = process.env.RELAY_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  }
  if (!config.maxQueuePerAgent && process.env.RELAY_MAX_QUEUE) {
    config.maxQueuePerAgent = parseInt(process.env.RELAY_MAX_QUEUE, 10);
  }
  if (!config.rateLimitPerMinute && process.env.RELAY_RATE_LIMIT) {
    config.rateLimitPerMinute = parseInt(process.env.RELAY_RATE_LIMIT, 10);
  }

  return config;
}

const config = parseArgs();
const hub = new RelayHub(config);

hub.start();

console.log("[perkos-a2a] Relay hub running");
console.log(`[perkos-a2a] Port: ${config.port || 6060}`);
console.log(`[perkos-a2a] Auth: ${config.apiKeys?.length ? "enabled" : "disabled (no API keys configured)"}`);

process.on("SIGINT", () => {
  console.log("\n[perkos-a2a] Shutting down relay hub...");
  hub.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  hub.stop();
  process.exit(0);
});
