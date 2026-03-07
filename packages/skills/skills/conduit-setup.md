# /conduit-setup Skill

When the user runs /conduit-setup, follow these steps exactly:

## Step 1: Get credentials

Ask the user:
"Please provide your Conduit server URL (e.g. https://conduit.example.com):"

Wait for their answer, then ask:
"Please provide your Conduit hook token (find this in your dashboard under Settings → Hook Token):"

## Step 2: Validate connection

Use the WebFetch tool to call:
GET {API_URL}/agent/prompts
Headers: Authorization: Bearer {HOOK_TOKEN}

If the response is not 200, tell the user: "Connection failed. Please check your URL and token." and stop.

## Step 3: Store credentials

Use the Bash tool to run:
```bash
cat > ~/.conduit << 'EOF'
{
  "apiUrl": "{API_URL}",
  "hookToken": "{HOOK_TOKEN}"
}
EOF
chmod 600 ~/.conduit
```

## Step 4: Register this instance

Use the WebFetch tool to call:
POST {API_URL}/agent/register
Headers:
  Authorization: Bearer {HOOK_TOKEN}
  Content-Type: application/json
Body: { "name": "{hostname}" }

(Get hostname from: `hostname` bash command)

## Step 5: Sync models

Check if the ANTHROPIC_API_KEY environment variable is set (use Bash: `echo $ANTHROPIC_API_KEY`).

If set, fetch available models:
GET https://api.anthropic.com/v1/models
Headers: x-api-key: {ANTHROPIC_API_KEY}, anthropic-version: 2023-06-01

Then call:
POST {API_URL}/agent/models
Headers: Authorization: Bearer {HOOK_TOKEN}, Content-Type: application/json
Body: { "models": [ ...array of { "providerId": "anthropic", "modelId": model.id, "modelName": model.display_name } ] }

If ANTHROPIC_API_KEY is not set, skip model sync and note it in the confirmation.

## Step 6: Confirm

Tell the user: "✓ Conduit setup complete! Your Claude Code sessions will now be tracked automatically."
