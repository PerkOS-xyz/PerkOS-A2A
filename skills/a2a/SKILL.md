# A2A Protocol Communication

Use this skill when you need to communicate with other agents in the council.

## Available Tools

### a2a_discover
Discover all peer agents, their capabilities, and online status.
Use this first to see who is available.

### a2a_send_task
Send a task to another agent. Provide the target agent name and a clear message.

Example: `a2a_send_task(target="tyr", message="Implement rate limiting on the Stack API")`

### a2a_task_status
Check the status of a previously sent task.

Example: `a2a_task_status(target="tyr", taskId="abc-123")`

## Agent Roles

- **mimir** — Strategy and orchestration. Assign planning and coordination tasks.
- **tyr** — Engineering and execution. Assign code, infra, and DevOps tasks.
- **bragi** — Communication and growth. Assign docs, copy, and social tasks.
- **idunn** — Product and design. Assign UX, design, and product tasks.

## Best Practices

1. Use `a2a_discover` to check agent availability before sending tasks
2. Send clear, specific tasks with acceptance criteria
3. Check task status with `a2a_task_status` after sending
4. One task per message — don't overload agents
