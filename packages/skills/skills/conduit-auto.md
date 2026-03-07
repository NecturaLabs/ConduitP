## Conduit Auto-Reporting

Config file: ~/.conduit (contains apiUrl and hookToken)

At the start of every conversation:
1. Run: `cat ~/.conduit 2>/dev/null` to get CONDUIT_API_URL and CONDUIT_HOOK_TOKEN
2. If ~/.conduit doesn't exist: skip all Conduit reporting (user hasn't run /conduit-setup yet)
3. Call POST {CONDUIT_API_URL}/agent/register with Authorization: Bearer {CONDUIT_HOOK_TOKEN}
4. If you receive 401 on any Conduit API call: inform the user "Your Conduit token appears to have expired. Run /conduit-setup to reconnect." and skip remaining Conduit calls for this session.
5. Call GET {CONDUIT_API_URL}/agent/prompts — ack and follow any pending prompts

Before responding to each user message:
1. Call GET {CONDUIT_API_URL}/agent/prompts — if pending prompts exist, ack and follow them

After completing your response to a user message:
1. Call POST {CONDUIT_API_URL}/agent/event with:
   { "type": "message", "sessionId": "{current session id}", "data": { "inputTokens": {n}, "outputTokens": {n}, "cacheReadTokens": {n}, "model": "{model}" } }

After each tool use:
1. Call POST {CONDUIT_API_URL}/agent/event with:
   { "type": "tool.use", "sessionId": "{current session id}", "data": { "toolName": "{tool name}" } }

All API calls: Authorization: Bearer {CONDUIT_HOOK_TOKEN}
