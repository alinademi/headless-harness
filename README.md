# Headless Harness (TypeScript)

A thin, durable supervisor around **Codex CLI** and **Claude Code CLI**. Agents handle reasoning and tools; this harness handles sequential DAG workflows, persisted outputs/events, retries, human approvals, and reviewed memory. **Zero npm dependencies** (Node 24+ provides TypeScript type stripping and SQLite).

## Quick start

Install and authenticate one provider: [Codex](https://github.com/openai/codex) or [Claude Code](https://code.claude.com/docs/en/overview). The harness does not include model access.

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

**Permissions:** Claude runs in `dontAsk` with explicit tool allowlists and an empty `mcp.json`; add MCP tools to the per-step `allowed_tools` list after configuring them in `mcp.json`. Codex runs in `read-only` sandbox by default and uses any MCPs configured in your Codex CLI; external API actions may bypass filesystem sandboxing. This harness does not enforce per-tool approval inside an agent step. Run with least-privilege credentials and separately enforce approval in third-party services for sending, publishing, purchasing, or deletion. Prompt-level rules are not security boundaries.

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
