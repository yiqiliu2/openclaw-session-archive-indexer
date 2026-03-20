# openclaw-session-archive-indexer

An [OpenClaw](https://openclaw.dev) plugin that indexes **archived/deleted/reset session transcripts** into the memory search system, so agents can search across all conversation history — not just active sessions.

## Problem

OpenClaw's built-in memory indexer only discovers session files ending in `.jsonl`. When sessions are deleted or reset, they get renamed to `.jsonl.deleted.<timestamp>` or `.jsonl.reset.<timestamp>` and become invisible to the indexer.

## Solution

This plugin creates **hardlinks** with `.jsonl` extension for each archived session file. Hardlinks are indistinguishable from regular files at the filesystem level, so the built-in indexer picks them up automatically. No patching required — survives OpenClaw upgrades.

Every hour (configurable), the plugin scans for:
- New archived sessions → creates hardlinks
- Changed active sessions or new memory files → triggers reindex

## Install

```bash
# Clone the repo
git clone https://github.com/yiqiliu2/openclaw-session-archive-indexer.git \
  ~/.openclaw/extensions/session-archive-indexer

# Enable the plugin
openclaw config set 'plugins.entries.session-archive-indexer.enabled' 'true' --json

# Enable session sources in memory search
openclaw config set 'agents.defaults.memorySearch.sources' '["memory","sessions"]' --json
openclaw config set 'agents.defaults.memorySearch.experimental.sessionMemory' 'true' --json

# Restart and reindex
openclaw gateway restart
openclaw memory index --force
```

## Configuration

Plugin config goes under `plugins.entries.session-archive-indexer`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `intervalMinutes` | number | `60` | How often to scan for changes (minutes) |
| `includeDeleted` | boolean | `true` | Index `.jsonl.deleted.*` files |
| `includeReset` | boolean | `true` | Index `.jsonl.reset.*` files |

Example:

```bash
openclaw config set 'plugins.entries.session-archive-indexer' \
  '{"enabled":true,"intervalMinutes":30}' --json
```

## CLI Commands

```bash
openclaw session-archives status   # Show indexer state
openclaw session-archives scan     # Force scan + reindex
openclaw session-archives clean    # Remove all hardlinks
```

## How It Works

1. Scans `~/.openclaw/agents/*/sessions/` for `.deleted.*` and `.reset.*` files
2. Creates hardlinks named `_arch_{uuid}_{type}_{timestamp}.jsonl` in the same directory
3. The built-in memory indexer sees these as regular `.jsonl` files and indexes them
4. On session `/new` or `/reset`, re-scans to immediately pick up the archived transcript
5. Tracks file mtimes/sizes to detect changes and trigger reindex only when needed

Hardlinks don't consume extra disk space (same inode as the original file) and don't interfere with session management (the session store only tracks entries in `sessions.json`).

## Requirements

- OpenClaw >= 2026.3.11
- Linux or macOS (hardlinks require same filesystem)

## License

MIT
