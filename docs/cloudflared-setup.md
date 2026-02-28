# Cloudflared Tunnel Setup

Orca uses a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) to expose its local API server to the internet so Linear can deliver webhooks. The tunnel module (`src/tunnel/index.ts`) runs `cloudflared tunnel run` and expects cloudflared to be fully configured beforehand. This guide walks through that setup.

## Prerequisites

- A **Cloudflare account** with at least one domain added and its nameservers pointed to Cloudflare ([instructions](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/))
- Orca installed and able to start (`npm run dev start`)

## 1. Install cloudflared

**Windows** (winget):
```powershell
winget install --id Cloudflare.cloudflared
```

**macOS** (Homebrew):
```bash
brew install cloudflared
```

**Debian / Ubuntu**:
```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg | sudo tee /usr/share/keyrings/cloudflare-public-v2.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

Verify:
```bash
cloudflared --version
```

## 2. Authenticate

```bash
cloudflared tunnel login
```

This opens a browser window. Log in to your Cloudflare account and select the domain you want to use. A certificate is saved to `~/.cloudflared/cert.pem`.

## 3. Create a named tunnel

```bash
cloudflared tunnel create orca
```

This creates:
- A tunnel UUID (printed to the terminal)
- A credentials file at `~/.cloudflared/<TUNNEL-UUID>.json`

Verify it exists:
```bash
cloudflared tunnel list
```

## 4. Route DNS

Create a CNAME record that points your chosen hostname to the tunnel:

```bash
cloudflared tunnel route dns orca orca.yourdomain.com
```

Replace `orca.yourdomain.com` with whatever subdomain you want to use. This creates a CNAME record in your Cloudflare DNS automatically.

## 5. Create the config file

Create `~/.cloudflared/config.yml` (on Windows: `%USERPROFILE%\.cloudflared\config.yml`):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /path/to/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: orca.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Replace:
- `<TUNNEL-UUID>` with the UUID from step 3
- `/path/to/.cloudflared/` with the actual path (e.g. `C:\Users\you\.cloudflared\` on Windows, `/home/you/.cloudflared/` on Linux)
- `orca.yourdomain.com` with your chosen hostname from step 4
- `3000` with your `ORCA_PORT` if you changed it from the default

The catch-all rule (`- service: http_status:404`) is required by cloudflared and handles requests that don't match any hostname.

Validate your config:
```bash
cloudflared tunnel ingress validate --config ~/.cloudflared/config.yml
```

## 6. Test the tunnel

Run the tunnel manually to verify it connects. Use the bare `cloudflared tunnel run` command (no tunnel name argument) — this is exactly how Orca invokes it, so it validates that your config file is correct:

```bash
cloudflared tunnel run
```

You should see log lines containing `connection ... registered` or `Registered tunnel connection`. In a separate terminal, verify the tunnel is reachable:

```bash
curl -I https://orca.yourdomain.com/api/health
```

Press Ctrl+C to stop the manual tunnel. Orca manages the tunnel process itself at runtime via `orca start`.

## 7. Configure Orca

In your `.env` file, set the tunnel hostname:

```
ORCA_TUNNEL_HOSTNAME=orca.yourdomain.com
```

When you run `orca start`, the tunnel module spawns `cloudflared tunnel run` automatically. No further cloudflared config is needed.

## 8. Set up the Linear webhook

1. Go to **Linear** > **Settings** > **API** > **Webhooks**
2. Create a new webhook with the URL:
   ```
   https://orca.yourdomain.com/api/webhooks/linear
   ```
3. Copy the **signing secret** Linear gives you
4. Set it in your `.env`:
   ```
   ORCA_LINEAR_WEBHOOK_SECRET=<signing-secret>
   ```

Orca uses this secret for HMAC verification of incoming webhook payloads.

## Troubleshooting

### `cloudflared tunnel run` exits immediately

- Check that `~/.cloudflared/config.yml` exists and is valid YAML
- Run `cloudflared tunnel ingress validate --config ~/.cloudflared/config.yml` to check for config errors
- Verify the credentials file path in your config matches the actual `.json` file

### Port conflict (address already in use)

The default config routes to `localhost:3000`. If something else is using port 3000:
- Stop the other process, or
- Change `ORCA_PORT` in `.env` and update the `service` URL in `config.yml` to match

### DNS not resolving

After `cloudflared tunnel route dns`, the CNAME may take a few minutes to propagate. Check with:
```bash
nslookup orca.yourdomain.com
```
It should resolve to a `*.cfargotunnel.com` address.

### Authentication expired

The certificate at `~/.cloudflared/cert.pem` can expire. Re-run:
```bash
cloudflared tunnel login
```

Note: the tunnel credentials file (`<UUID>.json`) does not expire. Only `cert.pem` (used for management operations like creating/deleting tunnels) expires.

### Tunnel connects but webhooks fail

- Verify the webhook URL in Linear matches your hostname exactly
- Check that Orca's API server is running and responding on `localhost:3000`
- Look at Orca's logs for HMAC verification failures (wrong `ORCA_LINEAR_WEBHOOK_SECRET`)
