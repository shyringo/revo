# Security

Revo v0 is a local, single-user research harness. It is not a security boundary for hostile users or hostile models.

## Enforced Defaults

- Interaction is terminal-native; Revo opens no listening network server.
- API keys never enter the life log or repository. A local installation may persist one in an explicitly configured private file.
- File paths are checked lexically and through resolved symbolic links against the configured workspace.
- Routine `write`, `edit`, and `bash` operations are approval-free by default, matching Revo's autonomous operating model.
- Shell commands recognized as destructive require explicit confirmation with the exact command visible. Set `REVO_APPROVAL_MODE=always` to confirm every write, edit, and command.
- There is no direct delete tool.
- Model and command execution have timeouts and bounded per-cycle step counts.
- Event history is append-only; context compaction does not erase evidence.

## Trust Boundaries

Approval and destructive-command recognition are not sandboxing. Shell syntax is too expressive for a pattern classifier to prove that a command is harmless; indirect deletion can evade recognition. In the default mode, Revo can change anything allowed by the operating-system account. Use `REVO_APPROVAL_MODE=always`, a disposable workspace, or a separate constrained operating-system identity when stronger isolation matters.

Workspace files and tool output can contain indirect prompt injection. Revo tells the model that observations are not permission, but a prompt is not a hard security control. Do not grant approvals based only on model confidence.

Configured plugins are trusted executable code with the full permissions of the Revo process. Load only reviewed local plugins; configuration never auto-discovers or downloads plugins.

The model provider still receives Revo's assembled context over its API. A production deployment needs a real sandbox, scoped credentials, provider-specific privacy review, and a separate operating-system identity.

## Secrets

Prefer `REVO_API_KEY` when practical. If persistent credentials are explicitly required, point `REVO_CONFIG` to a file outside the workspace and restrict it to the operating-system identity running Revo. Do not place keys in the workspace, messages, memories, life log, or committed configuration. Error messages redact common `sk-...` token forms, but provider-specific formats may require additional redactors.
