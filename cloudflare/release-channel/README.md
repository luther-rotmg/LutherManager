# LutherManager release-channel Worker

Serves the Electron auto-update channel at `luther-rotmg.com/api/releases/*`.

## Deploy

```
cd cloudflare/release-channel
wrangler deploy
```

## Health check

```
curl -H "Authorization: Bearer <token>" https://luther-rotmg.com/api/releases/health
```

## Mint a new install token

Preferred:
```
node scripts/mint-token.mjs --email champion@example.com --note "champion-dev-machine"
```

The script generates a token, writes it to the TOKENS KV via wrangler, prints
the file path where the subscriber pastes it, and prints the exact revocation
command. Add `--dry-run` to preview without touching KV.

Manual fallback (if wrangler isn't on PATH):
```
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
wrangler kv key put --binding=TOKENS "$TOKEN" '{"revoked":false,"email":"champion@example.com","install_date":"2026-07-20"}' --remote
echo "Paste into %USERPROFILE%\\Documents\\LutherManager\\update-token: $TOKEN"
```

## Revoke

```
wrangler kv key put --binding=TOKENS "$TOKEN" '{"revoked":true}' --remote
```

## Upload a release

```
# Local build first.
cd ../../Manager
npm run dist:portable

# Then push to R2.
VER=0.1.0
wrangler r2 object put luther-manager-releases/win/${VER}/LutherManager-${VER}-portable.exe --file release/LutherManager-${VER}-portable.exe --remote
wrangler r2 object put luther-manager-releases/win/${VER}/LutherManager-${VER}-portable.exe.blockmap --file release/LutherManager-${VER}-portable.exe.blockmap --remote

# Update manifest LAST — this makes the release live.
wrangler r2 object put luther-manager-releases/win/latest.yml --file release/latest.yml --remote
```

## Wire into Manager

Add to `Manager/electron-builder.json`:

```json
"publish": [
  {
    "provider": "generic",
    "url": "https://luther-rotmg.com/api/releases/win",
    "channel": "latest",
    "useMultipleRangeRequest": false
  }
]
```

The Bearer token needs to be readable by `electron-updater` — pass it via the app's runtime via `autoUpdater.addAuthHeader` or bake into `channel-provider` config. Exact wiring is a follow-up (electron-builder + electron-updater docs).
