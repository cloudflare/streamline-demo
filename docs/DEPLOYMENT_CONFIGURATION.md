# Deployment Configuration

The checked-in `wrangler.jsonc` is a safe example configuration. It contains no
account ID, deployment hostname, Access identity, or secret, and its placeholder
container image cannot be deployed as-is.

Use `owner` and `playground` only as deployment-profile names. Choose Worker
script names, origins, container names, and custom domains for each deployment.

## Private Operations Overlay

Keep real Wrangler configuration in the ignored `.ops/` directory. Point build,
typecheck, Access, and deployment commands at it with `STREAMLINE_OPS_DIR`:

```bash
mkdir -p .ops
cp wrangler.jsonc .ops/wrangler.jsonc
```

Replace every placeholder in the copied file with your account, Worker names,
origins, Access policy inputs, Container image, and Turnstile hostnames. Then
run commands against the overlay:

```bash
STREAMLINE_OPS_DIR=.ops npm run build:owner
```

The overlay directory must contain `wrangler.jsonc`. Its values configure the
account, Worker names, origins, Access policy inputs, container names, and
Turnstile hostnames. The build derives the outbound publisher-host map from its
configured origins and writes it to an ignored generated module.

For a deployed application, set each Container `image` to a versioned image in
the Cloudflare Registry, such as
`registry.cloudflare.com/<ACCOUNT_ID>/streamline:0.1.0`. Build and push that
image before deploying the Worker. Do not use the checked-in placeholder image
or an adjacent source checkout in a deployment configuration.

Store secrets with Wrangler and provide operator API tokens only through the
environment. Do not put secret values in the overlay, source repository, tests,
or generated files committed to version control.
