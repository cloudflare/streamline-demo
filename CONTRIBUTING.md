# Contributing

Issues and pull requests are welcome. Keep changes small, explain their user-visible behavior, and include tests for behavior or failure modes that change.

## Before Opening A Pull Request

```bash
npm ci
npm test
npm run typecheck
npm run build:owner
npm run build:playground
```

The demo currently requires an adjacent `streamline` checkout for the local package and Container build context. Changes to the shared protocol or Container behavior may require matching Streamline tests.

## Design Boundaries

- The demo consumes Streamline; do not introduce a dependency from Streamline back to this application.
- Keep owner and Playground resources, policies, and credentials isolated.
- Preserve authenticated principals, session-ID fencing, bounded queues and request bodies, and strict browser security headers.
- Do not expose stream keys, relay capabilities, signed URLs, credentials, or arbitrary FFmpeg arguments to browsers.

Agent-assisted contributions are welcome. Review generated changes, understand their behavior, and run the applicable checks before submitting. Never include credentials, private media URLs, or other sensitive data in issues, commits, pull requests, or test fixtures.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
