# Headless Harness (TypeScript)

A thin, durable supervisor around **Codex CLI** and **Claude Code CLI**. Agents handle reasoning and tools; this harness handles sequential DAG workflows, persisted outputs/events, retries, human approvals, and reviewed memory. **Zero npm dependencies** (Node 24+ provides TypeScript type stripping and SQLite).

## Quick start

Install one provider: [Codex](https://github.com/openai/codex) or [Claude Code](https://code.claude.com/docs/en/overview). Codex runs require `OPENAI_API_KEY` and intentionally **do not load your personal Codex login, plugins, or MCP configuration**. Claude can use its normal authentication. The harness does not include model access.

```sh
node src/harness.ts run workflows/content_pipeline.json --provider codex --goal "Research how AI changes local businesses"
# Or: --provider claude
```

Runs live on your machine; use a VPS + cron to run unattended:

```sh
node src/harness.ts submit workflows/content_pipeline.json --provider codex --goal "Analyze emerging AI products"
node src/harness.ts worker           # drain queue
node src/harness.ts worker --forever # poll every 10 seconds
node src/harness.ts status <job-id>
```

State is saved in `.harness/` (override via `HARNESS_HOME`) in SQLite. Individual attempts store `prompt.txt`, `events.jsonl`, `stderr.log`, and Codex's `last.txt` under `.harness/jobs/<job-id>/logs/<step-id>/attempt-N/`. Jobs share only their own workspace. Workflow dependencies receive previous step **final outputs**, not raw tool transcripts. Independent steps run sequentially.

## Human gates / recovery

Workflow steps default to `read-only`. Every `workspace-write` step **must** set `"approval": true`.

```sh
node src/harness.ts run workflows/approval_example.json --goal "Draft a newsletter launch"
node src/harness.ts approve <job-id> write
node src/harness.ts worker
```

Read-only steps retry once on normal failures; writable steps do not. If a worker dies during a step, that step is marked **uncertain**, requiring inspection before `node src/harness.ts retry <job-id> <step-id>`. Retrying resets any approval, so you must approve it again. External effects cannot be rolled back or made exactly-once by this harness.

**Permissions:** Claude runs in `dontAsk` with an explicit tool allowlist and strict `mcp.json` configuration. Any `allowed_tools` entry must be a named `mcp__server__tool` and its step must have `"approval": true`. Arbitrary shell tools cannot be added. Codex uses a fresh per-job `CODEX_HOME` with no inherited MCPs or plugins; Codex workflows cannot declare `allowed_tools`. Agent subprocesses inherit only a small environment allowlist and the active provider's credentials, not ambient GitHub/cloud tokens. Approved steps get **one attempt**, never automatic replay. This harness approves a step as a whole, not individual tool calls, and cannot undo external actions. Run with least-privilege credentials and enforce additional confirmation inside third-party services for sending, publishing, purchasing, or deletion. Prompt-level instructions and filesystem sandboxing are not complete security boundaries.

## Curated memory

```sh
node src/harness.ts memory add "Never cite unsourced market statistics"
node src/harness.ts dream <completed-job-id> --provider codex
node src/harness.ts memory proposals
node src/harness.ts memory promote <proposal-id> # or: memory reject <proposal-id>
node src/harness.ts memory list
```

Dreaming creates **proposals only**, never auto-installs instructions or skills. Approved snippets are retrieved via simple word overlap (no vector DB).

## Custom workflow

```json
{
  "name": "My workflow",
  "steps": [
    { "id": "research", "prompt": "Investigate the goal and cite sources" },
    { "id": "draft", "depends_on": ["research"], "prompt": "Create a proposal using research" }
  ]
}
```

## Tests / CI

```sh
npm test # fake Codex provider; no credentials required
```

`.github/workflows/example.yml` provides a manually triggered GitHub Actions example. CI runner storage is temporary, so it uploads logs as artifacts but **does not provide a persistent job queue**; use a durable host/volume for that.

**Limits:** single-host, single-worker; not a distributed workflow system. Logs can contain secrets and must be protected. Agents may inherit local credentials and global/project configuration. Workspaces are directories, not hardened containers. Do not run with privileged machine or unreviewed MCP credentials.

## Controlled team deployment

Use **one dedicated, unprivileged service account** on a dedicated host/VM with Node 24+, the provider CLI, a persistent encrypted `HARNESS_HOME`, and scoped provider credentials. Do not run the worker as root or mount administrator credentials. Protect `HARNESS_HOME` (SQLite, prompt files, raw tool logs and memory can all contain sensitive data). Provide regular SQLite-consistent backups, log retention, uptime/blocked-job alerts, and a procedure for inspecting uncertain jobs before retrying. Never share the same state directory between machines.

The included GitHub Actions workflow is a **stateless demo**, not a durable production queue. `ci.yml` tests PRs without using provider credentials. Real provider and security testing in your deployment environment is still required before enabling unattended external actions.

**Remaining blockers for general multi-user production:** no container/VM isolation per task, authenticated per-person approvals/RBAC or audit identity, enforced network egress policy, secrets broker, integrated alerting, or live provider/MCP tests. Use this only as a controlled internal pilot until those controls are supplied by your deployment platform.
