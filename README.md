# @perkos/perkos-a2a

Agent-to-Agent (A2A) protocol plugin for [OpenClaw](https://openclaw.ai). Enables secure multi-agent communication using Google's A2A protocol specification with enterprise-grade relay infrastructure for NAT traversal.

## 🔒 Security First

**A2A communication MUST be secured.** Without authentication, anyone on your network can send tasks to your agent, potentially executing arbitrary commands.

### Enable Authentication (REQUIRED for production)

```json
{
  "plugins": {
    "entries": {
      "perkos-a2a": {
        "config": {
          "agentName": "my-agent",
          "port": 5050,
          "auth": {
            "requireApiKey": true,
            "apiKeys": ["YOUR_SECRET_API_KEY"]
          },
          "peerAuth": {
            "other-agent": "THEIR_API_KEY"
          },
          "peers": {
            "other-agent": "http://10.0.0.2:5050"
          }
        }
      }
    }
  }
}
```

**Generate a secure API key:**
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**Security checklist:**
- ✅ `auth.requireApiKey: true` — reject unauthenticated inbound requests
- ✅ `auth.apiKeys` — list of accepted API keys for inbound requests
- ✅ `peerAuth` — API keys to send when making outbound requests to each peer
- ✅ All peers share the same API key (or use per-peer keys)
- ✅ API keys are **never** committed to public repos
- ✅ On VPS: bind A2A ports to `127.0.0.1` in Docker/firewall (see below)

**Without auth enabled:**
- ❌ Anyone on your network can send tasks to your agent
- ❌ Tasks can instruct the agent to execute commands, send messages, access files
- ❌ This is equivalent to giving someone shell access

### VPS Security: Bind Ports to Localhost

On VPS deployments (Docker Compose), bind A2A ports to `127.0.0.1` so they're not exposed externally:

```yaml
# docker-compose.yml
services:
  my-agent:
    ports:
      - "127.0.0.1:5050:5050"  # A2A only accessible from localhost
```

For external agent communication, use the **relay hub** instead of exposing ports.

## How Message Delivery Works

Understanding the delivery model is critical:

1. When Agent A sends a task to Agent B, the task is **received** by Agent B's A2A server
2. The plugin **enqueues a system event** in the agent's session and triggers a **wake** to process it immediately
3. The task is also injected via the `before_agent_start` hook as prepended context on the next agent turn
4. A `completed` status on `perkos_a2a_send` means "delivered to the server and queued" — the agent may need a moment to wake and process

**v0.8.1 delivery pipeline:**
```
Task received → enqueueSystemEvent() → requestHeartbeatNow() → Agent wakes → Processes task
                                    ↘ before_agent_start hook (backup) ↗
```

**Inspect pending tasks:**
```bash
curl -s -X POST http://localhost:5050/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"tasks/list","id":1,"params":{}}' | python3 -m json.tool
```

## Quick Start

```bash
# 1. Install the plugin
openclaw plugins install @perkos/perkos-a2a

# 2. Configure (see config section below)

# 3. Restart gateway to load the plugin
openclaw gateway restart

# 4. Run the setup wizard to detect your environment
openclaw perkos-a2a setup

# 5. Check status
openclaw perkos-a2a status
```

## Configuration Reference

```json
{
  "plugins": {
    "entries": {
      "perkos-a2a": {
        "enabled": true,
        "config": {
          "agentName": "my-agent",
          "port": 5050,
          "mode": "auto",
          "skills": [
            {
              "id": "research",
              "name": "Research",
              "description": "Web research and analysis",
              "tags": ["research", "analysis"]
            }
          ],
          "peers": {
            "other-agent": "http://10.0.0.2:5050"
          },
          "peerAuth": {
            "other-agent": "shared-secret-key"
          },
          "auth": {
            "requireApiKey": true,
            "apiKeys": ["shared-secret-key"]
          },
          "relay": {
            "url": "wss://relay.example.com:8787",
            "apiKey": "relay-api-key",
            "enabled": true
          }
        }
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `agentName` | string | `"agent"` | This agent's name in the network |
| `port` | number | `5050` | HTTP server port (avoid 5000 on macOS — AirPlay) |
| `mode` | string | `"auto"` | Operating mode: `auto`, `full`, `client-only`, `relay` |
| `skills` | array | `[]` | Skills exposed via the agent card |
| `peers` | object | `{}` | Map of peer names → A2A base URLs |
| `peerAuth` | object | `{}` | Map of peer names → API keys for outbound requests |
| `auth.requireApiKey` | boolean | `false` | **Set to `true` for production** |
| `auth.apiKeys` | string[] | `[]` | Accepted API keys for inbound requests |
| `relay.url` | string | — | Relay hub WebSocket URL |
| `relay.apiKey` | string | — | API key for relay hub authentication |
| `relay.enabled` | boolean | `false` | Enable relay connectivity |

## Modes

| Mode | HTTP Server | Relay Client | Best For |
|---|---|---|---|
| `auto` | Conditional | If configured | Most setups — auto-detects NAT |
| `full` | Yes | If configured | VPS with public IP, or LAN agents |
| `client-only` | No | If configured | Behind NAT, send only |
| `relay` | No (hub mode) | No | Running as relay hub |

## Authentication

### Inbound Auth (protecting your agent)

When `auth.requireApiKey: true`, all inbound HTTP requests must include an API key via one of:
- `X-API-Key: <key>` header (recommended)
- `Authorization: Bearer <key>` header
- `?apiKey=<key>` query parameter

Requests without a valid key receive `401 Unauthorized`.

**The agent card endpoint (`/.well-known/agent-card.json`) and health endpoint (`/health`) are always public** — they don't contain sensitive information.

### Outbound Auth (authenticating to peers)

Use `peerAuth` to send API keys when making requests to specific peers:

```json
"peerAuth": {
  "agent-b": "agent-b-accepts-this-key",
  "agent-c": "agent-c-accepts-this-key"
}
```

### Shared Key Setup (simplest)

For a small team of trusted agents, use the same API key everywhere:

```bash
# Generate one shared key
python3 -c "import secrets; print(secrets.token_hex(32))"
# Example: a1b2c3d4e5f6...
```

Each agent configures:
```json
"auth": { "requireApiKey": true, "apiKeys": ["a1b2c3d4e5f6..."] },
"peerAuth": { "peer-name": "a1b2c3d4e5f6..." }
```

### Per-Peer Keys (more secure)

For larger deployments, each agent pair can use unique keys. Agent A's outbound key to B must match B's inbound `apiKeys`, and vice versa.

### Relay Auth

Agents authenticate with the relay hub using the `relay.apiKey`. The hub rejects connections with invalid keys.

## Agent Tools

When the plugin is active, three tools are available to the agent:

| Tool | Description |
|---|---|
| `perkos_a2a_discover` | Discover all configured peer agents and their capabilities |
| `perkos_a2a_send` | Send a task to a named peer (direct HTTP → relay fallback) |
| `perkos_a2a_status` | Check the status of a previously sent task by ID |

## CLI Commands

```bash
openclaw perkos-a2a setup      # Detect environment and show recommendations
openclaw perkos-a2a status     # Show agent status, peers, and config
openclaw perkos-a2a discover   # Discover peer agents (direct + relay)
openclaw perkos-a2a send <target> <message>  # Send a task to a peer
```

## Architecture

### Direct Peer-to-Peer

Agents on the same network or with public IPs communicate directly via HTTP JSON-RPC 2.0.

```
Agent A                           Agent B
┌─────────────┐                  ┌─────────────┐
│ OpenClaw GW  │                  │ OpenClaw GW  │
│  └─ A2A     │──── HTTP ────────│  └─ A2A     │
│     plugin   │  JSON-RPC 2.0   │     plugin   │
│     :5050    │◄────────────────│     :5051    │
└─────────────┘                  └─────────────┘
```

### Relay Hub (NAT Traversal)

Agents behind NAT connect outbound to the relay hub via WebSocket. No port forwarding needed.

```
Agent A (NAT)        Relay Hub (VPS)       Agent B (NAT)
┌──────────┐        ┌──────────────┐      ┌──────────┐
│ A2A      │──WSS──▶│ WS Broker    │◀─WSS─│ A2A      │
│ plugin   │◀──WSS──│ Msg Queue    │──WSS─▶│ plugin   │
└──────────┘        │ Agent Registry│      └──────────┘
                    │ Rate Limiter  │
                    └──────────────┘
```

## Multi-Agent LAN Setup (Same WiFi)

### Step 1: Assign unique ports per agent

| Agent | Machine IP | Port |
|-------|-----------|------|
| alice | 192.168.10.89 | 5055 |
| morpheus | 192.168.10.88 | 5051 |

### Step 2: Generate a shared API key

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### Step 3: Configure each agent

**Alice (192.168.10.89:5055):**
```json
{
  "agentName": "alice",
  "port": 5055,
  "mode": "full",
  "peers": {
    "morpheus": "http://192.168.10.88:5051"
  },
  "peerAuth": {
    "morpheus": "SHARED_API_KEY"
  },
  "auth": {
    "requireApiKey": true,
    "apiKeys": ["SHARED_API_KEY"]
  }
}
```

**Morpheus (192.168.10.88:5051):**
```json
{
  "agentName": "morpheus",
  "port": 5051,
  "mode": "full",
  "peers": {
    "alice": "http://192.168.10.89:5055"
  },
  "peerAuth": {
    "alice": "SHARED_API_KEY"
  },
  "auth": {
    "requireApiKey": true,
    "apiKeys": ["SHARED_API_KEY"]
  }
}
```

### Step 4: Restart gateways and test

```bash
# On each machine:
openclaw gateway restart

# Verify peer is reachable:
curl -s http://192.168.10.88:5051/.well-known/agent-card.json

# Send authenticated test:
curl -s -X POST http://192.168.10.88:5051/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -H "x-api-key: SHARED_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"tasks/list","id":1,"params":{}}'
```

## Running the Relay Hub

Deploy the relay hub on a VPS with a public IP for NAT traversal.

```bash
# Via npx
npx tsx bin/relay.ts --port 8787 --api-keys key1,key2

# Via environment variables
RELAY_PORT=8787 RELAY_API_KEYS=key1,key2 npx tsx bin/relay.ts
```

| Option | Env Var | Default | Description |
|---|---|---|---|
| `--port` | `RELAY_PORT` | 6060 | WebSocket listen port |
| `--api-keys` | `RELAY_API_KEYS` | — | Comma-separated accepted API keys |
| `--max-queue` | `RELAY_MAX_QUEUE` | 200 | Max queued messages per offline agent |
| `--rate-limit` | `RELAY_RATE_LIMIT` | 60 | Max messages per agent per minute |

## Troubleshooting

| Problem | Solution |
|---|---|
| **401 Unauthorized** | Ensure your `x-api-key` header matches the target's `auth.apiKeys` |
| **Port in use** | Change `port` in config. Run `lsof -i :5050` to find conflicts. After gateway restart, old ports may linger — do a full `stop` + `start` |
| **Peers offline** | Verify peer URL and port. Check firewall. Use `curl` to test reachability |
| **Tasks received but not processed** | Check logs for `enqueueSystemEvent` and `Wake triggered`. If missing, update to v0.8.1+ |
| **Relay connection failing** | Verify relay URL. Check API key matches hub config. Look for `[perkos-a2a]` log messages |
| **Port 5000 conflict on macOS** | AirPlay Receiver uses port 5000. Use 5050+ instead |

**View plugin logs:**
```bash
# Find log file
openclaw gateway status 2>&1 | grep "File logs"

# Filter A2A logs
grep "perkos-a2a" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -20
```

## Changelog

### v0.8.1
- **Wake mechanism**: Uses `requestHeartbeatNow` from the gateway runtime for reliable immediate wake (no WebSocket auth needed)
- **System event injection**: Tasks are enqueued as system events via `enqueueSystemEvent` for the main session
- **Dual delivery**: Both system event + `before_agent_start` hook for belt-and-suspenders reliability

### v0.8.0
- Added `enqueueSystemEvent` integration for task delivery
- WebSocket-based wake (replaced in v0.8.1 due to gateway auth complexity)

### v0.6.1
- Fixed install command in README
- Added `peerAuth` to config schema and types

### v0.6.0
- Initial public release
- Direct HTTP + relay hub communication
- Agent tools: discover, send, status
- CLI commands: setup, status, discover, send

## License

MIT — [PerkOS](https://perkos.xyz)
