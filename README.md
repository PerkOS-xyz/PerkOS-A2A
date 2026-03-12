# @perkos/a2a

Agent-to-Agent (A2A) protocol communication plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Implements Google's [A2A Protocol](https://github.com/a2aproject/A2A) (v0.3.0) to enable OpenClaw agents to discover each other, send tasks, and collaborate autonomously.

## Features

- **Agent Card Discovery** — Each agent publishes identity and skills at `/.well-known/agent-card.json`
- **JSON-RPC 2.0** — Standard A2A protocol methods: `message/send`, `tasks/get`, `tasks/list`, `tasks/cancel`
- **OpenClaw Tools** — `a2a_discover`, `a2a_send_task`, `a2a_task_status` available to the LLM
- **CLI Commands** — `openclaw a2a status`, `openclaw a2a discover`, `openclaw a2a send`
- **Peer Discovery** — Automatic discovery of online agents in the network
- **Background Service** — A2A HTTP server runs alongside the OpenClaw gateway

## Installation

```bash
openclaw plugins install @perkos/a2a
```

Or manually:

```bash
npm install @perkos/a2a
```

## Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "perkos-a2a": {
        enabled: true,
        config: {
          agentName: "mimir",
          port: 5000,
          skills: [
            { id: "strategy", name: "Strategic Planning", description: "Break down goals into tasks", tags: ["planning"] }
          ],
          peers: {
            tyr: "http://perkos-tyr:5000",
            bragi: "http://perkos-bragi:5000",
            idunn: "http://perkos-idunn:5000"
          }
        }
      }
    }
  }
}
```

## Usage

### From Chat (via OpenClaw tools)

The plugin registers three tools that the agent can use:

```
"Discover all agents in the council"
→ calls a2a_discover

"Send Tyr a task to implement rate limiting"
→ calls a2a_send_task(target="tyr", message="Implement rate limiting...")

"Check status of task abc-123 on Tyr"
→ calls a2a_task_status(target="tyr", taskId="abc-123")
```

### From CLI

```bash
# Check A2A status
openclaw a2a status

# Discover peer agents
openclaw a2a discover

# Send a task
openclaw a2a send tyr "Review the API architecture"
```

### HTTP API

```bash
# Get agent card
curl http://localhost:5000/.well-known/agent-card.json

# Discover peers
curl http://localhost:5000/a2a/peers

# Send task via REST
curl -X POST http://localhost:5000/a2a/send \
  -H "Content-Type: application/json" \
  -d '{"target": "tyr", "message": "Build the feature"}'

# Send task via JSON-RPC
curl -X POST http://localhost:5000/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "1",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "parts": [{"kind": "text", "text": "Your task here"}]
      }
    }
  }'
```

## Architecture

```
┌─────────────────────────────────────────┐
│              OpenClaw Agent             │
│                                         │
│  ┌──────────┐    ┌──────────────────┐  │
│  │  Gateway  │    │  @perkos/a2a     │  │
│  │ (port 3k) │    │  (port 5k)      │  │
│  │           │    │                  │  │
│  │  LLM ←───┼────┤  a2a_send_task   │  │
│  │           │    │  a2a_discover    │  │
│  │  Telegram │    │  a2a_task_status │  │
│  └──────────┘    └───────┬──────────┘  │
│                          │              │
└──────────────────────────┼──────────────┘
                           │ A2A JSON-RPC
                           ▼
              ┌────────────────────────┐
              │    Other A2A Agents    │
              │  (peers in the network)│
              └────────────────────────┘
```

## A2A Protocol Compliance

This plugin implements the [A2A Protocol Specification RC v1.0](https://a2a-protocol.org/latest/specification/):

- Agent Card at `/.well-known/agent-card.json`
- JSON-RPC 2.0 binding
- Task lifecycle (submitted → working → completed/failed/canceled)
- Message parts (text)
- Artifact generation

## License

MIT

## Links

- [A2A Protocol](https://github.com/a2aproject/A2A)
- [OpenClaw](https://github.com/openclaw/openclaw)
- [PerkOS](https://perkos.xyz)
