# PerkOS A2A - Agent Skill Guide

## Overview

The PerkOS A2A plugin enables communication between OpenClaw agents using Google's Agent-to-Agent (A2A) protocol. Use these tools to delegate work, discover peers, and track task progress.

## Tools

### a2a_discover

Discover all peer agents in the council. Returns each agent's online/offline status, description, and skills.

**When to use:** Before sending a task, to check which agents are available and what they can do.

**Parameters:** None

**Example:**
```
Use a2a_discover to see which agents are online.
```

### a2a_send_task

Send a task to a specific peer agent. The task is delivered via JSON-RPC and queued for processing.

**When to use:** When you need another agent to perform work -- research, code generation, data processing, etc.

**Parameters:**
- `target` (required): Name of the peer agent (must match a key in the peers config)
- `message` (required): The task description/instructions to send

**Example:**
```
Use a2a_send_task to ask "mimir" to "Research the latest A2A protocol specification changes"
```

### a2a_task_status

Check the status of a previously sent task by its ID.

**When to use:** After sending a task, to poll for completion or check progress.

**Parameters:**
- `target` (required): Name of the agent that received the task
- `taskId` (required): The task ID returned from a2a_send_task

**Task states:** submitted, working, completed, failed, canceled

## Workflows

### Delegate and check back

1. `a2a_discover` -- see who's online
2. `a2a_send_task` -- send the task to a capable peer
3. `a2a_task_status` -- check on progress (may need to poll)

### Multi-agent coordination

1. Discover available agents
2. Send different subtasks to different agents based on their skills
3. Collect results via task status checks
4. Combine outputs for the user

## Notes

- Tasks are asynchronous. After sending, the peer agent processes independently.
- If the plugin is in client-only mode, you can send tasks but peers cannot send tasks to you.
- Peer URLs must be configured in the plugin config before you can communicate with them.
