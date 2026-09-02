# Canonfig v2.2.0

## Features

- Added privacy-safe JSON Lines command lifecycle logging with user-only file permissions, explicit opt-out, normalized command names, and catchable-signal completion records.
- Added first-class strict JSON harness configuration through `canonfig harness init --format json`, using the same schema and compiler as YAML.
- Added secure secret synchronization between authorized enrolled devices over pinned TLS, backed by native credential stores and automatic synchronization after successful apply operations.

## Security and reliability

- Secret values are accepted through standard input only and are never written to manifests, command arguments, normal output, or command logs.
- Revocation, source deletion, collisions, interrupted transfers, aggregate payload limits, and failed credential cleanup are handled fail-closed with retryable durable state.
- Ambiguous YAML and JSON harness configurations are rejected instead of silently selecting one.
- Command logs never record unrecognized tokens and apply protected current-user-only access controls on Windows.

## Documentation

- Updated the README, complete CLI reference, security reference, installation skills, and platform-specific installation instructions.
- Added a reproducible release runbook and validated command examples across repository and website documentation.

Full changelog: https://github.com/Microck/canonfig/compare/v2.1.1...v2.2.0
