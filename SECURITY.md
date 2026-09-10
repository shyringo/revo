# Security Policy

Revo is an experimental local harness, not a hardened sandbox. Do not expose its TUI or process to untrusted users, and do not approve commands you have not inspected.

## Reporting

Before a public repository exists, report vulnerabilities privately to the repository owner. After publication, use GitHub private vulnerability reporting when enabled. Do not include live credentials, private life logs, or exploitable user data in a public issue.

## Supported Version

Only the latest commit on the default branch will receive security fixes before the first stable release.

## Credential Boundary

Credentials must stay outside Git and the life log. Persistent authentication belongs in an explicit private configuration protected by operating-system permissions. Public examples use non-secret sample values.

See [docs/security.md](docs/security.md) for the complete trust model.
