# /conduit-setup Skill

Follow these steps when the user runs /conduit-setup:

## Step 1: Get API URL

Ask: "What is your Conduit server URL? (e.g. https://conduit.example.com)"

Store as CONDUIT_API_URL.

## Step 2: Check existing credentials

Run: `cat ~/.conduit 2>/dev/null`

If the file exists and contains an apiUrl and hookToken:
- Call GET {apiUrl}/agent/prompts with Authorization: Bearer {hookToken}
- If 200: credentials are valid. Skip to Step 6 (confirm).
- If not 200: credentials are invalid or expired. Continue to Step 3.

If the file doesn't exist: continue to Step 3.

## Step 3: Start device flow

Call POST {CONDUIT_API_URL}/agent/auth/device (no auth headers needed).

Expected response:
{
  "deviceCode": "...",
  "userCode": "BCDF-GHJK",
  "verificationUrl": "...",
  "expiresIn": 600,
  "interval": 5
}

Tell the user:
"To connect Claude Code to Conduit:
1. Visit: {verificationUrl}
2. Log in to your Conduit account if prompted
3. Enter this code: {userCode}
4. Click Approve

I'll wait while you complete this..."

## Step 4: Poll for approval

Poll GET {CONDUIT_API_URL}/agent/auth/poll?deviceCode={deviceCode} every 5 seconds.

Use the Bash tool: `sleep 5 && curl -s "{CONDUIT_API_URL}/agent/auth/poll?deviceCode={deviceCode}"`

Continue polling until:
- Response is `{ "status": "approved", "token": "..." }` → store the token, go to Step 5
- Response is `{ "status": "expired" }` → tell user "Code expired. Run /conduit-setup again." and stop
- 10 minutes have passed → tell user "Timed out. Run /conduit-setup again." and stop

## Step 5: Store credentials

Run:
```bash
cat > ~/.conduit << 'EOF'
{
  "apiUrl": "CONDUIT_API_URL_VALUE",
  "hookToken": "TOKEN_VALUE"
}
EOF
chmod 600 ~/.conduit
```
(Replace CONDUIT_API_URL_VALUE and TOKEN_VALUE with the actual values)

## Step 6: Register this instance

Call POST {CONDUIT_API_URL}/agent/register:
- Authorization: Bearer {hookToken}
- Content-Type: application/json
- Body: { "name": "claude-code@{hostname}" }

Get hostname via: `hostname`

## Step 7: Sync models (optional)

Check: `echo $ANTHROPIC_API_KEY`

If set:
- GET https://api.anthropic.com/v1/models with x-api-key header and anthropic-version: 2023-06-01
- POST {CONDUIT_API_URL}/agent/models with the model list

## Step 8: Confirm

Say: "✓ Conduit setup complete! Your Claude Code sessions will now be tracked automatically."
