#!/usr/bin/env tsx
import "dotenv/config";
import http from "node:http";
import querystring from "node:querystring";
import crypto from "node:crypto";

import providersHandler from "./api/providers.js";
import queryHandler from "./api/query.js";
import mcpHandler from "./api/mcp.js";
import usageHandler from "./api/usage.js";
import recommendHandler from "./api/recommend.js";
import { getAllProviders, getProvider } from "./lib/providers/registry.js";
import { recommend, compareProviders } from "./lib/reasoning/engine.js";
import { providerKnowledge } from "./lib/reasoning/provider-knowledge.js";
import { getAccount, getAccountByEmail, getUsage, getAllAccounts, createAccount, addToWaitlist, logUsage, logRouting, getRoutingStats } from "./lib/db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT) || 3000;

// ─── Streamable HTTP MCP ────────────────────────────────────────────────────
const mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

async function createMcpSession(accountId: string): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer }> {
  const server = new McpServer({ name: "procurement-labs", version: "0.1.0" });

  server.tool(
    "list_providers",
    "Browse all available API providers. Optionally filter by category.",
    { category: z.string().optional() },
    async ({ category }) => {
      let providers = getAllProviders();
      if (category) providers = providers.filter((p) => p.info.category === category);
      if (providers.length === 0) {
        return { content: [{ type: "text", text: `No providers found${category ? ` for category: ${category}` : ""}.` }] };
      }
      const lines = providers.map((p) => {
        const actions = p.info.availableActions
          .map((a) => {
            const paramStr = Object.entries(a.parameters)
              .map(([k, v]) => `${k} (${(v as any).type}${(v as any).required ? ", required" : ""})`)
              .join(", ");
            return `    - ${a.action}: ${a.description} [${paramStr}]`;
          })
          .join("\n");
        return [
          `## ${p.info.name} (${p.info.id})`,
          `Category: ${p.info.category}`,
          `Status: ${p.isAvailable() ? "Ready" : "Not configured"}`,
          `Description: ${p.info.description}`,
          `Actions:\n${actions}`,
        ].join("\n");
      });
      return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
    }
  );

  server.tool(
    "query",
    "Execute a real API call to any available provider. Includes smart routing: if the requested provider fails or is unavailable, automatically falls back to an alternative provider.",
    {
      provider_id: z.string(),
      action: z.string(),
      params: z.record(z.unknown()).optional(),
    },
    async ({ provider_id, action, params: queryParams }) => {
      const provider = getProvider(provider_id);
      if (!provider) {
        return { content: [{ type: "text", text: `Error: Provider '${provider_id}' not found` }], isError: true };
      }

      // Try the requested provider first
      if (provider.isAvailable()) {
        const result = await provider.query(action, queryParams || {});
        logUsage(accountId, provider_id, action, result.success).catch(() => {});
        logRouting({ accountId, requestedProvider: provider_id, actualProvider: provider_id, action, reason: "direct", fallback: false, success: result.success }).catch(() => {});

        if (result.success) {
          return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
        }

        // Provider failed — try fallbacks
        const knowledge = providerKnowledge[provider_id];
        if (knowledge?.alternatives?.length) {
          for (const altId of knowledge.alternatives) {
            const alt = getProvider(altId);
            if (!alt || !alt.isAvailable()) continue;
            // find a matching action on the alternative
            const altAction = alt.info.availableActions.find((a) => a.action === action);
            if (!altAction) continue;
            const altResult = await alt.query(action, queryParams || {});
            logUsage(accountId, altId, action, altResult.success).catch(() => {});
            logRouting({ accountId, requestedProvider: provider_id, actualProvider: altId, action, reason: `${provider_id} failed, routed to ${altId}`, fallback: true, success: altResult.success }).catch(() => {});
            if (altResult.success) {
              return { content: [{ type: "text", text: `[Routed: ${provider_id} → ${altId}]\n\n${JSON.stringify(altResult.data, null, 2)}` }] };
            }
          }
        }

        return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
      }

      // Requested provider unavailable — try alternatives silently
      const knowledge = providerKnowledge[provider_id];
      if (knowledge?.alternatives?.length) {
        for (const altId of knowledge.alternatives) {
          const alt = getProvider(altId);
          if (!alt || !alt.isAvailable()) continue;
          const altAction = alt.info.availableActions.find((a) => a.action === action);
          if (!altAction) continue;
          const altResult = await alt.query(action, queryParams || {});
          logUsage(accountId, altId, action, altResult.success).catch(() => {});
          logRouting({ accountId, requestedProvider: provider_id, actualProvider: altId, action, reason: `${provider_id} unavailable, routed to ${altId}`, fallback: true, success: altResult.success }).catch(() => {});
          if (altResult.success) {
            return { content: [{ type: "text", text: `[Routed: ${provider_id} → ${altId}]\n\n${JSON.stringify(altResult.data, null, 2)}` }] };
          }
        }
      }

      return { content: [{ type: "text", text: `Error: Provider '${provider.info.name}' is not configured and no alternatives are available` }], isError: true };
    }
  );

  server.tool(
    "smart_query",
    "Describe what data you need in plain language. The system automatically picks the best available provider, optimizing for cost, availability, and reliability. No need to know provider names.",
    {
      intent: z.string().describe("What you need — e.g. 'current weather in Tokyo', 'Bitcoin price', 'FDA recalls for ibuprofen'"),
      params: z.record(z.unknown()).optional().describe("Any specific parameters for the query"),
    },
    async ({ intent, params: extraParams }) => {
      const recommendations = recommend({ need: intent, priorities: ["reliability", "cost"] });
      const available = recommendations.filter((r) => r.available);
      if (available.length === 0) {
        return { content: [{ type: "text", text: `No available providers match "${intent}". Use list_providers to see what's configured.` }], isError: true };
      }

      // Try each recommended provider in order until one succeeds
      for (const rec of available) {
        const provider = getProvider(rec.provider_id);
        if (!provider) continue;

        // Pick the best matching action
        const action = rec.actions[0];
        const actionDef = provider.info.availableActions.find((a) => a.action === action);
        if (!actionDef) continue;

        // Build params from intent + extraParams
        const queryParams = { ...(extraParams || {}) };
        // Auto-extract common params from intent
        if (!queryParams.query && !queryParams.city && !queryParams.symbol && !queryParams.coins) {
          // Try to extract the subject from the intent
          const intentWords = intent.replace(/^(get|find|show|what|what's|whats|the|current|latest|recent)\s+/gi, "").trim();
          const firstAction = actionDef;
          const firstRequired = Object.entries(firstAction.parameters).find(([, v]) => (v as any).required);
          if (firstRequired) {
            queryParams[firstRequired[0]] = intentWords;
          }
        }

        const result = await provider.query(action, queryParams);
        logUsage(accountId, rec.provider_id, action, result.success).catch(() => {});
        logRouting({ accountId, requestedProvider: "smart_query", actualProvider: rec.provider_id, action, reason: `smart routing: score ${rec.score}`, fallback: false, success: result.success }).catch(() => {});

        if (result.success) {
          return { content: [{ type: "text", text: `[Smart Route → ${rec.provider_name} / ${action}]\n\n${JSON.stringify(result.data, null, 2)}` }] };
        }
        // Try next provider if this one failed
      }

      return { content: [{ type: "text", text: `All providers failed for "${intent}". Try being more specific or use query with a specific provider.` }], isError: true };
    }
  );

  server.tool(
    "recommend",
    "Get intelligent recommendations for which API provider to use based on your needs. Compares pricing, rate limits, reliability, and capabilities. Use this before querying to pick the best provider.",
    {
      need: z.string().describe("Describe what you need — e.g. 'I need real-time stock prices' or 'cheapest way to do sentiment analysis'"),
      priorities: z.array(z.enum(["cost", "reliability", "speed", "data-quality", "no-auth"])).optional()
        .describe("What matters most to you"),
      budget: z.enum(["free", "low", "any"]).optional().describe("Budget constraint"),
    },
    async ({ need, priorities, budget }) => {
      const results = recommend({ need, priorities, budget });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching providers found for that need. Try rephrasing or use list_providers to browse all available APIs." }] };
      }
      const text = results.map((r, i) => [
        `## ${i + 1}. ${r.provider_name} (${r.provider_id}) — Score: ${r.score}/100`,
        `${r.reasoning}`,
        `Actions: ${r.actions.join(", ")}`,
        `Pricing: ${r.pricing.model}${r.pricing.freeTier ? ` (free tier: ${r.pricing.freeTier})` : ""}`,
        `Rate limits: ${r.rateLimits.free || "N/A"}`,
        `Available: ${r.available ? "✅ Ready" : "❌ Needs API key"}`,
      ].join("\n")).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "compare",
    "Compare two or more providers side by side on pricing, rate limits, strengths, weaknesses, and capabilities.",
    {
      provider_ids: z.array(z.string()).min(2).describe("Provider IDs to compare — e.g. ['claude', 'gemini']"),
    },
    async ({ provider_ids }) => {
      const results = compareProviders(provider_ids);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching providers found. Use list_providers to see valid IDs." }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) mcpSessions.delete(sid);
  };

  await server.connect(transport);

  return { transport, server };
}

// ─── OAuth 2.0 ──────────────────────────────────────────────────────────────

type PendingCode = { apiKey: string; redirectUri: string; codeChallenge: string; expiresAt: number };
const pendingCodes = new Map<string, PendingCode>();
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pendingCodes) if (data.expiresAt < now) pendingCodes.delete(code);
}, 60_000);

function getBaseUrl(req: http.IncomingMessage): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function verifyPKCE(verifier: string, challenge: string): boolean {
  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return hash === challenge;
}

function parseFormBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const parsed = querystring.parse(data);
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) result[k] = Array.isArray(v) ? v[0]! : (v ?? "");
      resolve(result);
    });
  });
}

function renderAuthorizeForm(opts: {
  clientId: string; redirectUri: string; state: string;
  codeChallenge: string; codeChallengeMethod: string; error?: string;
}): string {
  const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, error } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Procurement Labs — Connect</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem}
  .card{width:100%;max-width:380px}
  h1{font-size:1.1rem;font-weight:600;color:#fff;margin-bottom:.25rem}
  .sub{font-size:.85rem;color:#737373;margin-bottom:1.5rem}
  .error{background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.3);color:#f87171;font-size:.8rem;padding:.75rem 1rem;border-radius:.5rem;margin-bottom:1rem}
  input{width:100%;background:#111;border:1px solid #262626;border-radius:.5rem;padding:.75rem 1rem;color:#e5e5e5;font-size:.9rem;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color .15s;margin-bottom:.75rem}
  input:focus{border-color:#525252}
  input::placeholder{color:#404040}
  button{width:100%;background:#e5e5e5;color:#0a0a0a;border:none;border-radius:.5rem;padding:.75rem;font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s}
  button:hover{background:#fff}
  .hint{font-size:.75rem;color:#404040;margin-top:1rem;text-align:center}
  .hint a{color:#525252;text-decoration:none}
  .hint a:hover{color:#a3a3a3}
</style>
</head>
<body>
<div class="card">
  <h1>Procurement Labs</h1>
  <p class="sub">Enter your API key to connect</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
    <input name="api_key" placeholder="pl_…" autofocus autocomplete="off" spellcheck="false">
    <button type="submit">Authorize</button>
  </form>
  <p class="hint">Need a key? Contact your administrator.</p>
</div>
</body>
</html>`;
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function makeRes(res: http.ServerResponse) {
  const r: any = res;
  const originalEnd = res.end.bind(res);
  r.status = (code: number) => { res.statusCode = code; return r; };
  r.json = (obj: unknown) => {
    res.setHeader("Content-Type", "application/json");
    originalEnd(JSON.stringify(obj));
    return r;
  };
  return r;
}

function getHealthData() {
  const providers = getAllProviders();
  return providers.map((p) => ({
    id: p.info.id,
    name: p.info.name,
    category: p.info.category,
    description: p.info.description,
    requiresApiKey: p.info.requiresApiKey,
    available: p.isAvailable(),
    actions: p.info.availableActions.map((a) => ({
      name: a.action,
      description: a.description,
      params: Object.entries(a.parameters).map(([k, v]) => ({
        name: k, type: v.type, required: v.required, description: v.description,
      })),
    })),
  }));
}

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  physical_health: { label: "Health", icon: "H" },
  mental_health: { label: "Mental Health", icon: "M" },
  ai: { label: "AI", icon: "A" },
  financial: { label: "Finance", icon: "F" },
  social_impact: { label: "Social Impact", icon: "S" },
  environment: { label: "Environment", icon: "E" },
  maps: { label: "Maps", icon: "G" },
  cloud: { label: "Cloud", icon: "C" },
};

interface AccountWithUsage {
  key: string;
  email: string | null;
  tier: string;
  quota: number;
  used: number;
  remaining: number;
  perMinuteRate: number;
  createdAt: string;
}

const SHARED_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const SHARED_STYLES = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',-apple-system,sans-serif;background-color:#050505;background-image:radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px);background-size:20px 20px;color:#ededed;line-height:1.6;-webkit-font-smoothing:antialiased;min-height:100vh;}
  a{color:#888;text-decoration:none;transition:color .2s ease}
  a:hover{color:#fff}
  .container{max-width:1000px;margin:0 auto;padding:0 2rem}
  nav{border-bottom:1px solid rgba(255,255,255,0.05);padding:1.25rem 0;position:sticky;top:0;z-index:50;background:rgba(5,5,5,0.9);backdrop-filter:blur(10px);}
  nav .container{display:flex;justify-content:space-between;align-items:center}
  nav .logo{font-family:'Geist Mono','JetBrains Mono',monospace;font-weight:700;color:#fff;font-size:1rem;letter-spacing:-0.03em;text-transform:lowercase;display:flex;align-items:center;gap:0.5rem;}
  nav .links{display:flex;gap:2rem;font-size:0.85rem;font-weight:500;}
  nav .links a{color:#777}
  nav .links a:hover{color:#fff}
  nav .links a.active{color:#fff}
  .btn{display:inline-flex;align-items:center;justify-content:center;padding:0.75rem 1.75rem;border-radius:0.5rem;font-size:0.9rem;font-weight:600;letter-spacing:-0.01em;transition:all .2s ease;cursor:pointer;border:1px solid transparent;text-decoration:none;}
  .btn-primary{background:#fff;color:#000}
  .btn-primary:hover{background:#ddd;color:#000;transform:translateY(-1px)}
  .btn-ghost{background:rgba(255,255,255,0.02);border-color:rgba(255,255,255,0.1);color:#ccc}
  .btn-ghost:hover{border-color:rgba(255,255,255,0.3);color:#fff;background:rgba(255,255,255,0.05)}
  .page-footer{border-top:1px solid rgba(255,255,255,0.05);padding:3rem 0;margin-top:5rem;display:flex;justify-content:space-between;font-size:0.8rem;color:#555}
`;

function renderNav(active?: string): string {
  return `<nav><div class="container">
    <a href="/" class="logo">procurement labs</a>
    <div class="links">
      <a href="/how-it-works"${active === "how" ? ' class="active"' : ""}>how it works</a>
      <a href="/login"${active === "login" ? ' class="active"' : ""}>login</a>
    </div>
  </div></nav>`;
}

function renderHomepage(): string {
  const providers = getHealthData();
  const total = providers.length;
  const live = providers.filter((p) => p.available).length;
  const categories = Object.keys(CATEGORY_META);

  const categoryList = categories.map(cat => {
    const meta = CATEGORY_META[cat] || { label: cat, icon: "·" };
    const count = providers.filter(p => p.category === cat).length;
    return `<span class="cat-tag">${escapeHtml(meta.label.toLowerCase())} (${count})</span>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${SHARED_HEAD}
<title>procurement labs — api gateway for agents</title>
<style>
${SHARED_STYLES}

  /* ── hero ── */
  .hero{padding:3rem 0 2rem;text-align:center;}
  .hero h1{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:2.8rem;font-weight:700;color:#fff;letter-spacing:-0.05em;margin-bottom:1rem;line-height:1.1;text-transform:lowercase;}
  .hero .tagline{font-size:1rem;color:#777;max-width:500px;margin:0 auto 1.5rem;line-height:1.7;}

  /* ── ascii art box ── */
  .ascii-box{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:0.72rem;line-height:1.35;color:#ccc;text-align:center;margin:0 auto 1.5rem;white-space:pre;user-select:none;letter-spacing:0.02em;}

  /* ── game canvas ── */
  .game-wrap{position:relative;max-width:700px;margin:0 auto 3rem;border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;overflow:hidden;background:#0a0a0a;}
  .game-canvas{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:0.75rem;line-height:1.25;color:#555;white-space:pre;padding:1rem 1.5rem;height:140px;overflow:hidden;display:flex;align-items:flex-end;}
  #game-display{width:100%;}

  /* ── waitlist (hero position) ── */
  .waitlist-hero{text-align:center;margin-bottom:3rem;}
  .waitlist-hero p{font-size:0.85rem;color:#666;margin-bottom:1rem;}
  .waitlist-hero form{display:flex;gap:0.5rem;max-width:420px;margin:0 auto}
  .waitlist-hero input[type="email"]{flex:1;padding:0.7rem 1rem;background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:0.375rem;color:#fff;font-size:0.85rem;outline:none;font-family:'Geist Mono','JetBrains Mono',monospace;transition:border-color 0.2s}
  .waitlist-hero input[type="email"]:focus{border-color:rgba(255,255,255,0.3)}
  .waitlist-hero .btn-wait{padding:0.7rem 1.25rem;background:#fff;color:#000;border:none;border-radius:0.375rem;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap;transition:all 0.2s;font-family:inherit}
  .waitlist-hero .btn-wait:hover{background:#ddd;transform:translateY(-1px)}
  .waitlist-hero .msg{font-size:0.8rem;margin-top:0.75rem;min-height:1.2em;font-weight:500;}
  .waitlist-hero .msg.ok{color:#4ade80}
  .waitlist-hero .msg.err{color:#f87171}

  /* ── pitch ── */
  .pitch{text-align:center;max-width:620px;margin:0 auto 4rem;font-size:0.95rem;color:#666;line-height:1.8;}
  .pitch strong{color:#ccc;font-weight:600;}

  /* ── stats ── */
  .stats-row{display:flex;gap:1px;background:rgba(255,255,255,0.05);border-radius:0.75rem;overflow:hidden;border:1px solid rgba(255,255,255,0.08);margin-bottom:4rem}
  .stats-row .s{flex:1;padding:1.5rem 1.25rem;background:#0a0a0a;text-align:center}
  .stats-row .sv{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:1.75rem;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-0.03em;}
  .stats-row .sl{font-size:0.7rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-top:0.35rem;font-weight:600;}

  /* ── categories (plain text) ── */
  .categories{margin-bottom:4rem;text-align:center;}
  .categories h2{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:0.75rem;text-transform:lowercase;letter-spacing:0.08em;color:#555;margin-bottom:1rem;font-weight:500;}
  .cat-tags{display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center;max-width:600px;margin:0 auto;}
  .cat-tag{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:0.75rem;color:#888;padding:0.35rem 0.75rem;border:1px solid rgba(255,255,255,0.08);border-radius:0.25rem;background:transparent;}

  /* ── terminal ── */
  .terminal{background:#0a0a0a;border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:1.5rem 2rem;max-width:640px;margin:0 auto 4rem;font-family:'Geist Mono','JetBrains Mono',monospace;font-size:0.8rem;line-height:1.6;}
  .terminal .prompt{color:#555}
  .terminal .cmd{color:#ddd}
  .terminal .out{color:#666;margin-top:0.75rem;border-top:1px dashed rgba(255,255,255,0.08);padding-top:0.75rem;}

  /* ── popup overlay ── */
  .popup-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);}
  .popup-overlay.visible{display:flex}
  .popup-card{background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:2rem;max-width:400px;width:90%;position:relative;text-align:center;}
  .popup-card h3{font-family:'Geist Mono','JetBrains Mono',monospace;font-size:1rem;color:#fff;margin-bottom:0.5rem;font-weight:600;text-transform:lowercase;}
  .popup-card p{font-size:0.85rem;color:#777;margin-bottom:1.5rem;line-height:1.5;}
  .popup-card form{display:flex;gap:0.5rem;}
  .popup-card input[type="email"]{flex:1;padding:0.65rem 1rem;background:#0a0a0a;border:1px solid rgba(255,255,255,0.1);border-radius:0.375rem;color:#fff;font-size:0.85rem;outline:none;font-family:'Geist Mono','JetBrains Mono',monospace;}
  .popup-card input[type="email"]:focus{border-color:rgba(255,255,255,0.3)}
  .popup-card .btn-wait{padding:0.65rem 1rem;background:#fff;color:#000;border:none;border-radius:0.375rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit}
  .popup-card .btn-wait:hover{background:#ddd}
  .popup-close{position:absolute;top:0.75rem;right:1rem;background:none;border:none;color:#555;font-size:1.25rem;cursor:pointer;padding:0.25rem;line-height:1;}
  .popup-close:hover{color:#fff}
  .popup-card .msg{font-size:0.8rem;margin-top:0.75rem;min-height:1.2em}
  .popup-card .msg.ok{color:#4ade80}
  .popup-card .msg.err{color:#f87171}

  @media(max-width:768px){
    .stats-row{flex-direction:column}
    .ascii-box{font-size:0.5rem}
    .game-canvas{font-size:0.55rem;height:100px;}
  }
  @media(max-width:640px){
    .hero{padding:2.5rem 0 2rem}
    .hero h1{font-size:1.8rem}
    .waitlist-hero form{flex-direction:column}
    .popup-card form{flex-direction:column}
    .ascii-box{font-size:0.4rem}
    .game-canvas{font-size:0.45rem;height:80px;padding:0.5rem 0.75rem}
  }
</style>
</head>
<body>
${renderNav()}
<div class="container">
  <div class="hero">
    <div class="ascii-box">
 ┌──────────────────────────────────────────────┐
 │                                              │
 │   ╱╲      procurement       ╱╲              │
 │  ╱  ╲       labs           ╱  ╲             │
 │ ╱    ╲    ──────────      ╱    ╲            │
 │╱ ▓▓▓▓ ╲   api gateway    ╱ ▓▓▓▓ ╲           │
 │  ▓▓▓▓  ╲   for agents   ╱  ▓▓▓▓             │
 │                                              │
 └──────────────────────────────────────────────┘</div>
    <h1>one key. every api.<br>zero friction.</h1>
    <p class="tagline">procurement labs is an <strong>mcp gateway that removes the api layer from your workflow entirely</strong>. you never register for a provider, never touch a raw key, never write rate-limit logic. we maintain the provider credentials — your agent queries us through mcp, and we handle auth, retries, fallbacks, and usage tracking for every call behind the scenes. the one key you install unlocks all of them at once.</p>
  </div>

  <div class="waitlist-hero">
    <p>alpha drops soon — get early access</p>
    <form id="waitlist-form">
      <input type="email" name="email" placeholder="you@example.com" required>
      <button type="submit" class="btn-wait">join waitlist</button>
    </form>
    <div class="msg" id="waitlist-msg"></div>
  </div>

  <div class="game-wrap">
    <div class="game-canvas"><div id="game-display"></div></div>
  </div>

  <div class="pitch">
    stop integrating apis. we already signed up for weather, finance, health, maps, and more — your ai agent just asks for data, we fetch it. no provider accounts, no .env files, no credentials on your machine.
  </div>

  <div class="stats-row">
    <div class="s"><div class="sv">${total}</div><div class="sl">providers</div></div>
    <div class="s"><div class="sv">${live}</div><div class="sl">live</div></div>
    <div class="s"><div class="sv">${categories.length}</div><div class="sl">categories</div></div>
    <div class="s"><div class="sv">500</div><div class="sl">free requests/mo</div></div>
  </div>

  <div class="categories">
    <h2>available categories</h2>
    <div class="cat-tags">${categoryList}</div>
  </div>

  <div class="terminal">
    <div><span class="prompt">$</span> <span class="cmd">claude mcp add procurement-labs \\</span></div>
    <div><span class="cmd">    --transport http https://pclabs.dev/api/mcp \\</span></div>
    <div><span class="cmd">    --header "x-pl-key: pl_your_key"</span></div>
    <div class="out">done. restart your session to use ${total} providers.</div>
  </div>

  <footer class="page-footer">
    <span>procurement labs v0.1.0</span>
    <a href="https://github.com/tobasummandal/procurementlabs">github</a>
  </footer>
</div>

<!-- email popup (5s delay) -->
<div class="popup-overlay" id="email-popup">
  <div class="popup-card">
    <button class="popup-close" id="popup-close" aria-label="Close">&times;</button>
    <h3>don't miss early access</h3>
    <p>we're opening to a small first wave. drop your email — no spam, just the key when it's ready.</p>
    <form id="popup-form">
      <input type="email" name="email" placeholder="you@example.com" required>
      <button type="submit" class="btn-wait">notify me</button>
    </form>
    <div class="msg" id="popup-msg"></div>
  </div>
</div>

<script>
  // cookie check
  if (document.cookie.match(/pl_key=/)) {
    var links = document.querySelectorAll('nav .links a');
    links.forEach(function(a) { if (a.textContent === 'Login') { a.href = '/dashboard'; a.textContent = 'Dashboard'; } });
  }

  // ── ascii game (sphere jumping over mountains) ──
  (function() {
    var W = 80, H = 10;
    var sphereX = 12, sphereY = 0, velY = 0, jumping = false;
    var gravity = 0.4, jumpForce = -2.2;
    var frame = 0;
    var scrollOffset = 0;

    // sphere flash colors (warm tones only — no pink/purple/green)
    var colors = ['#fff', '#fff', '#fff', '#fff', '#e8c36a', '#6aace8', '#e8a86a', '#c4c4c4', '#fff', '#fff'];
    var currentColor = '#fff';
    var flashTimer = 0;

    // mountain pattern (repeating) using simple ASCII
    var mountainPattern = [
      '                                /\\\\                                                   /\\\\                                      ',
      '                  /\\\\           /  \\\\                                                 /  \\\\                /\\\\                   ',
      '                 /  \\\\         /    \\\\                                               /    \\\\              /  \\\\                  ',
      '                /    \\\\       /      \\\\                  /\\\\                        /      \\\\            /    \\\\                 ',
      '               /      \\\\     /        \\\\               /  \\\\                      /        \\\\          /      \\\\                ',
      '______________/________\\\\___/          \\\\______________/    \\\\____________________/          \\\\________/        \\\\_______________',
    ];
    var patternW = mountainPattern[0].length;

    function getGroundY() { return H - mountainPattern.length - 1; }

    function tick() {
      frame++;
      scrollOffset += 0.35;

      // auto-jump
      if (!jumping && Math.random() < 0.018) {
        jumping = true;
        velY = jumpForce;
      }

      // physics
      if (jumping) {
        sphereY += velY;
        velY += gravity;
        if (sphereY >= 0) {
          sphereY = 0;
          jumping = false;
          velY = 0;
        }
      }

      // flash color occasionally
      flashTimer--;
      if (flashTimer <= 0 && Math.random() < 0.02) {
        currentColor = colors[Math.floor(Math.random() * colors.length)];
        flashTimer = 8 + Math.floor(Math.random() * 15);
      }
      if (flashTimer <= 0) currentColor = '#fff';

      render();
      requestAnimationFrame(tick);
    }

    function render() {
      var grid = [];
      for (var y = 0; y < H; y++) {
        grid[y] = [];
        for (var x = 0; x < W; x++) grid[y][x] = ' ';
      }

      // draw mountains
      var groundStart = getGroundY();
      for (var my = 0; my < mountainPattern.length; my++) {
        for (var x = 0; x < W; x++) {
          var srcX = Math.floor((x + scrollOffset) % patternW);
          if (srcX < 0) srcX += patternW;
          var ch = mountainPattern[my].charAt(srcX) || ' ';
          var gy = groundStart + my;
          if (gy < H) grid[gy][x] = ch;
        }
      }

      // draw sphere
      var sy = groundStart - 1 + Math.round(sphereY);
      if (sy >= 0 && sy < H) grid[sy][sphereX] = 'O';

      // build output as DOM nodes (no innerHTML)
      var el = document.getElementById('game-display');
      if (!el) return;

      while (el.firstChild) el.removeChild(el.firstChild);

      for (var i = 0; i < H; i++) {
        var line = grid[i].join('');
        var si = line.indexOf('O');
        if (si !== -1 && currentColor !== '#fff') {
          el.appendChild(document.createTextNode(line.substring(0, si)));
          var span = document.createElement('span');
          span.style.color = currentColor;
          span.style.fontWeight = 'bold';
          span.textContent = 'O';
          el.appendChild(span);
          el.appendChild(document.createTextNode(line.substring(si + 1)));
        } else {
          el.appendChild(document.createTextNode(line));
        }
        el.appendChild(document.createTextNode('\\n'));
      }
    }

    tick();
  })();

  // ── waitlist form handler ──
  function handleWaitlist(formId, msgId) {
    document.getElementById(formId).addEventListener('submit', async function(e) {
      e.preventDefault();
      var msg = document.getElementById(msgId);
      var btn = this.querySelector('.btn-wait');
      var email = this.email.value.trim();
      btn.disabled = true;
      btn.textContent = '...';
      try {
        var r = await fetch('/api/waitlist', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({email: email})
        });
        if (r.ok) {
          msg.className = 'msg ok';
          msg.textContent = "you're in. we'll reach out soon.";
          btn.textContent = 'done';
          window.__waitlistDone = true;
        } else {
          var d = await r.json();
          msg.className = 'msg err';
          msg.textContent = d.error || 'something went wrong';
          btn.textContent = 'join waitlist';
          btn.disabled = false;
        }
      } catch(err) {
        msg.className = 'msg err';
        msg.textContent = 'network error — try again';
        btn.textContent = 'join waitlist';
        btn.disabled = false;
      }
    });
  }
  handleWaitlist('waitlist-form', 'waitlist-msg');
  handleWaitlist('popup-form', 'popup-msg');

  // ── 5-second popup ──
  setTimeout(function() {
    if (window.__waitlistDone) return;
    document.getElementById('email-popup').classList.add('visible');
  }, 5000);

  document.getElementById('popup-close').addEventListener('click', function() {
    document.getElementById('email-popup').classList.remove('visible');
  });
  document.getElementById('email-popup').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('visible');
  });
</script>
</body>
</html>`;
}

function renderHowItWorks(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${SHARED_HEAD}
<title>How It Works — Procurement Labs</title>
<style>
${SHARED_STYLES}
  .page-title{padding:3rem 0 1rem}
  .page-title h1{font-size:1.5rem;font-weight:600;color:#fff;letter-spacing:-0.02em}
  .page-title p{color:#525252;font-size:0.85rem;margin-top:0.5rem}

  .steps{padding:2rem 0}
  .step{display:flex;gap:1.5rem;margin-bottom:2.5rem}
  .step-num{width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;background:#1c1c1c;border-radius:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:#525252;flex-shrink:0;margin-top:0.1rem}
  .step-body h3{font-size:0.95rem;font-weight:500;color:#e5e5e5;margin-bottom:0.5rem}
  .step-body p{font-size:0.85rem;color:#737373;margin-bottom:0.75rem}
  .step-body pre{background:#111;border:1px solid #262626;border-radius:0.5rem;padding:1rem 1.25rem;font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:#a3a3a3;overflow-x:auto;margin-bottom:0.5rem}
  .step-body code{font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:#a3a3a3;background:#1c1c1c;padding:0.1rem 0.4rem;border-radius:0.25rem}

  .cta-box{background:#111;border:1px solid #262626;border-radius:0.75rem;padding:2rem;text-align:center;margin-top:2rem}
  .cta-box p{color:#525252;font-size:0.85rem;margin-bottom:1rem}

  @media(max-width:640px){.step{flex-direction:column;gap:0.75rem}}
</style>
</head>
<body>
${renderNav("how")}
<div class="container">
  <div class="page-title">
    <h1>How It Works</h1>
    <p>From zero to querying APIs in under a minute.</p>
  </div>

  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-body">
        <h3>Create an account</h3>
        <p>Enter your email on the <a href="/login">sign up page</a>. You'll get a unique API key instantly — no credit card, no approval process. The free tier gives you 500 requests per month.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body">
        <h3>Add to your AI tool</h3>
        <p>Works with any MCP-compatible client. One command for Claude Code:</p>
        <pre>claude mcp add procurement-labs \\
  --transport http https://pclabs.dev/api/mcp \\
  --header "x-pl-key: pl_your_key"</pre>
        <p>For <strong>Codex</strong>, run this command:</p>
        <pre>codex mcp add procurement-labs --url https://pclabs.dev/api/mcp</pre>
        <p>For <strong>Cursor</strong>, add to <code>~/.cursor/mcp.json</code>:</p>
        <pre>{
  "mcpServers": {
    "procurement-labs": {
      "url": "https://pclabs.dev/api/mcp",
      "headers": { "x-pl-key": "pl_your_key" }
    }
  }
}</pre>
        <p>Works the same way in Windsurf, Claude Desktop, and claude.ai.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">3</div>
      <div class="step-body">
        <h3>Get smart recommendations</h3>
        <p>Not sure which API to use? The reasoning layer analyzes your needs and compares providers on cost, rate limits, reliability, and capabilities.</p>
        <pre>POST /api/recommend
{ "need": "I need real-time stock data",
  "priorities": ["cost", "reliability"],
  "budget": "free" }

→ Recommends Finnhub (score: 85/100)
  "Free tier: 60 calls/min. High reliability."</pre>
        <p>Also available as the <code>recommend</code> and <code>compare</code> MCP tools.</p>
      </div>
    </div>

    <div class="step">
      <div class="step-num">4</div>
      <div class="step-body">
        <h3>Use it</h3>
        <p>Ask your AI agent naturally. It will call the right provider automatically.</p>
        <pre>"what's the weather in tokyo?"          → OpenWeatherMap
"look up adverse events for ibuprofen"  → OpenFDA
"get the BTC price"                     → CoinGecko
"find nonprofits for climate change"    → Every.org</pre>
      </div>
    </div>

    <div class="step">
      <div class="step-num">5</div>
      <div class="step-body">
        <h3>Track usage</h3>
        <p>Visit the <a href="/dashboard">dashboard</a> to see your quota, per-provider breakdown, and rate limits in real time. Your key is remembered — no need to sign in again.</p>
      </div>
    </div>
  </div>

  <div class="cta-box">
    <p>Ready to get started?</p>
    <a href="/login" class="btn btn-primary">Create your key</a>
  </div>

  <footer class="page-footer">
    <span>procurement labs v0.1.0</span>
    <a href="https://github.com/tobasummandal/procurementlabs">github</a>
  </footer>
</div>
<script>
  if (document.cookie.match(/pl_key=/)) {
    var links = document.querySelectorAll('nav .links a');
    links.forEach(function(a) { if (a.textContent === 'Login') { a.href = '/dashboard'; a.textContent = 'Dashboard'; } });
  }
</script>
</body>
</html>`;
}

function renderLogin(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${SHARED_HEAD}
<title>Sign In — Procurement Labs</title>
<style>
${SHARED_STYLES}
  .login-page{padding:4rem 0;max-width:420px;margin:0 auto}
  .login-page h1{font-size:1.25rem;font-weight:600;color:#fff;margin-bottom:0.5rem}
  .login-page .sub{color:#525252;font-size:0.85rem;margin-bottom:2rem}

  .login-panel{background:#111;border:1px solid #262626;border-radius:0.75rem;padding:1.5rem;margin-bottom:1.5rem}
  .login-panel h2{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:#737373;margin-bottom:0.75rem;font-weight:500}
  .login-panel p{font-size:0.8rem;color:#525252;margin-bottom:0.75rem}
  .login-panel input{width:100%;background:#0a0a0a;border:1px solid #262626;border-radius:0.5rem;padding:0.65rem 1rem;color:#e5e5e5;font-size:0.85rem;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color .15s;margin-bottom:0.75rem}
  .login-panel input[type="email"]{font-family:'Inter',sans-serif}
  .login-panel input:focus{border-color:#525252}
  .login-panel button{width:100%;padding:0.65rem;font-size:0.85rem}
  .login-error{color:#f87171;font-size:0.75rem;margin-top:0.5rem}
  .or-divider{text-align:center;color:#333;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;margin:1.5rem 0;position:relative}
  .or-divider::before,.or-divider::after{content:'';position:absolute;top:50%;width:40%;height:1px;background:#1c1c1c}
  .or-divider::before{left:0}
  .or-divider::after{right:0}

  .toggle-mode{margin-top:1rem;font-size:0.75rem;color:#525252;text-align:center}
  .toggle-mode a{color:#a3a3a3;margin-left:0.375rem;text-decoration:underline;text-underline-offset:2px}
  .toggle-mode a:hover{color:#fff}

  .flash{background:rgba(255,255,255,0.04);border:1px solid #333;border-radius:0.5rem;padding:1rem 1.25rem;margin-bottom:1.5rem;display:none}
  .flash.visible{display:block}
  .flash-label{font-size:0.7rem;color:#525252;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.375rem}
  .flash-key{font-family:'JetBrains Mono',monospace;font-size:0.9rem;color:#e5e5e5;cursor:pointer;word-break:break-all}
  .flash-key:hover{color:#fff}
  .flash-sub{font-size:0.7rem;color:#404040;margin-top:0.375rem}

  .copied-toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#e5e5e5;color:#0a0a0a;padding:0.5rem 1rem;border-radius:0.375rem;font-size:0.75rem;font-weight:600;opacity:0;transition:opacity .2s;pointer-events:none}
  .copied-toast.show{opacity:1}
</style>
</head>
<body>
${renderNav("login")}
<div class="container">
  <div class="login-page">
    <h1>Welcome</h1>
    <p class="sub">Sign in with your existing key or create a new account.</p>

    <div id="key-flash" class="flash">
      <div class="flash-label">Your API key — click to copy</div>
      <div id="flash-key" class="flash-key"></div>
      <div class="flash-sub">Save this key. Add it to your MCP client as <code style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:#a3a3a3;background:#1c1c1c;padding:0.1rem 0.3rem;border-radius:0.25rem">x-pl-key</code> header.</div>
    </div>

    <div class="login-panel">
      <h2 id="email-panel-title">Sign In</h2>
      <p id="email-panel-sub">Sign in with your email</p>
      <input type="email" id="email-input" placeholder="you@example.com">
      <button class="btn btn-primary" id="email-submit-btn">Sign in</button>
      <div id="email-error" class="login-error"></div>
      <div class="toggle-mode">
        <span id="toggle-mode-text">Don't have an account?</span>
        <a href="#" id="toggle-mode-link">Create one</a>
      </div>
    </div>

    <div class="or-divider">or</div>

    <div class="login-panel">
      <h2>Sign In With Key</h2>
      <p>For teams sharing one key</p>
      <input type="text" id="signin-key" placeholder="pl_your_key" autocomplete="off" spellcheck="false">
      <button class="btn btn-ghost" id="signin-btn" style="width:100%;padding:0.65rem;font-size:0.85rem">Sign in</button>
      <div id="signin-error" class="login-error"></div>
    </div>

    <footer class="page-footer">
      <span>procurement labs v0.1.0</span>
      <a href="https://github.com/tobasummandal/procurementlabs">github</a>
    </footer>
  </div>
</div>
<div class="copied-toast" id="copied-toast">Copied</div>
<script>
(function() {
  // If already signed in, go to dashboard
  if (document.cookie.match(/pl_key=/)) {
    window.location.href = '/dashboard';
    return;
  }

  function setCookie(name, val) {
    document.cookie = name + '=' + encodeURIComponent(val) + '; path=/; max-age=' + (365*86400) + '; samesite=lax';
  }

  // Unified email panel — toggles between sign-in and create
  var mode = 'signin';
  var titleEl = document.getElementById('email-panel-title');
  var subEl = document.getElementById('email-panel-sub');
  var btnEl = document.getElementById('email-submit-btn');
  var toggleText = document.getElementById('toggle-mode-text');
  var toggleLink = document.getElementById('toggle-mode-link');
  var emailInput = document.getElementById('email-input');
  var errEl = document.getElementById('email-error');

  function setMode(m) {
    mode = m;
    errEl.textContent = '';
    if (m === 'signin') {
      titleEl.textContent = 'Sign In';
      subEl.textContent = 'Sign in with your email';
      btnEl.textContent = 'Sign in';
      toggleText.textContent = "Don't have an account?";
      toggleLink.textContent = 'Create one';
    } else {
      titleEl.textContent = 'Create Account';
      subEl.textContent = 'Free — 500 requests/month';
      btnEl.textContent = 'Create account';
      toggleText.textContent = 'Already have an account?';
      toggleLink.textContent = 'Sign in';
    }
  }

  toggleLink.addEventListener('click', function(e) {
    e.preventDefault();
    setMode(mode === 'signin' ? 'signup' : 'signin');
    emailInput.focus();
  });

  btnEl.addEventListener('click', doEmailSubmit);
  emailInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doEmailSubmit(); });

  async function doEmailSubmit() {
    var email = emailInput.value.trim();
    errEl.textContent = '';
    if (!email || !email.includes('@')) { errEl.textContent = 'Enter a valid email'; return; }
    var originalText = btnEl.textContent;
    btnEl.disabled = true; btnEl.textContent = '...';
    try {
      if (mode === 'signin') {
        var res = await fetch('/api/signin-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json();
        if (!res.ok) {
          // If no account, offer to create one
          if (res.status === 404) {
            errEl.innerHTML = 'No account found. <a href="#" id="switch-to-signup" style="color:#a3a3a3;text-decoration:underline">Create one instead?</a>';
            document.getElementById('switch-to-signup').addEventListener('click', function(e) {
              e.preventDefault();
              setMode('signup');
              emailInput.focus();
            });
          } else {
            errEl.textContent = data.error || 'Sign in failed';
          }
          return;
        }
        window.location.href = '/dashboard';
      } else {
        var res = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Signup failed'; return; }
        // Show key
        var flash = document.getElementById('key-flash');
        var flashKey = document.getElementById('flash-key');
        flashKey.textContent = data.key;
        flashKey.onclick = function() {
          navigator.clipboard.writeText(data.key);
          var t = document.getElementById('copied-toast');
          t.classList.add('show');
          setTimeout(function() { t.classList.remove('show'); }, 1200);
        };
        flash.classList.add('visible');
        setTimeout(function() { window.location.href = '/dashboard'; }, 3000);
      }
    } catch (e) { errEl.textContent = 'Connection error'; }
    finally { btnEl.disabled = false; btnEl.textContent = originalText; }
  }

  // Sign in
  document.getElementById('signin-btn').addEventListener('click', doSignin);
  document.getElementById('signin-key').addEventListener('keydown', function(e) { if (e.key === 'Enter') doSignin(); });

  async function doSignin() {
    var key = document.getElementById('signin-key').value.trim();
    var errEl = document.getElementById('signin-error');
    errEl.textContent = '';
    if (!key) { errEl.textContent = 'Enter your API key'; return; }
    try {
      var res = await fetch('/api/usage', { headers: { 'x-pl-key': key } });
      if (!res.ok) { errEl.textContent = 'Invalid key'; return; }
      setCookie('pl_key', key);
      window.location.href = '/dashboard';
    } catch (e) { errEl.textContent = 'Connection error'; }
  }
})();
</script>
</body>
</html>`;
}

function renderDashboard(): string {
  const providers = getHealthData();
  const total = providers.length;
  const live = providers.filter((p) => p.available).length;
  const noKey = providers.filter((p) => !p.requiresApiKey).length;

  const grouped: Record<string, typeof providers> = {};
  for (const p of providers) {
    const cat = p.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }

  const categoryCards = Object.entries(grouped)
    .map(([cat, provs]) => {
      const meta = CATEGORY_META[cat] || { label: cat, icon: "·" };
      const providerRows = provs
        .map((p) => {
          const status = p.available
            ? `<span class="badge live">LIVE</span>`
            : p.requiresApiKey
              ? `<span class="badge no-key">NO KEY</span>`
              : `<span class="badge live">LIVE</span>`;
          const actionList = p.actions
            .map((a) => {
              const params = a.params
                .map((pr) => `<span class="param${pr.required ? " required" : ""}">${pr.name}</span>`)
                .join(" ");
              return `<div class="action"><code>${a.name}</code><span class="action-desc">${a.description}</span><div class="params">${params}</div></div>`;
            })
            .join("");
          return `
            <div class="provider">
              <div class="provider-header">
                <div class="provider-title">
                  <h3>${p.name}</h3>
                  <span class="provider-id">${p.id}</span>
                </div>
                ${status}
              </div>
              <p class="provider-desc">${p.description}</p>
              <div class="actions-list">${actionList}</div>
            </div>`;
        })
        .join("");
      return `
        <div class="category">
          <div class="category-header">
            <span class="category-icon">${meta.icon}</span>
            <h2>${meta.label}</h2>
            <span class="category-count">${provs.length}</span>
          </div>
          ${providerRows}
        </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Procurement Labs</title>
<style>
  ${SHARED_STYLES}
  /* Header */
  header {
    margin-bottom: 3rem;
  }
  header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: #fff;
    margin-bottom: 0.5rem;
  }
  header p {
    color: #737373;
    font-size: 0.9rem;
  }

  /* Stats bar */
  .stats {
    display: flex;
    gap: 1px;
    background: rgba(255,255,255,0.05);
    border-radius: 1rem;
    overflow: hidden;
    margin-bottom: 2.5rem;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  }
  .stat {
    flex: 1;
    padding: 1.5rem;
    background: rgba(10,10,10,0.6);
    backdrop-filter: blur(10px);
  }
  .stat-value {
    font-size: 1.75rem;
    font-weight: 700;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  .stat-value.green { color: #4ade80; }
  .stat-value.amber { color: #a3a3a3; }
  .stat-label {
    font-size: 0.75rem;
    color: #737373;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.25rem;
  }

  /* Routing Stats */
  .routing-stats{display:flex;gap:1px;background:#1c1c1c;border-radius:0.75rem;overflow:hidden;border:1px solid #262626}
  .routing-stat{flex:1;padding:1rem;background:#111;text-align:center}
  .routing-stat-value{font-size:1.5rem;font-weight:600;color:#fff;font-variant-numeric:tabular-nums}
  .routing-stat-label{font-size:0.65rem;color:#525252;text-transform:uppercase;letter-spacing:0.05em;margin-top:0.25rem}
  .routing-provider{display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid #1c1c1c;font-size:0.8rem}
  .routing-provider:last-child{border-bottom:none}
  .routing-provider .name{color:#a3a3a3}
  .routing-provider .count{color:#525252;font-family:'JetBrains Mono',monospace;font-size:0.75rem}
  .routing-provider .bar{height:4px;background:#333;border-radius:2px;flex:1;margin:0 1rem;position:relative}
  .routing-provider .bar-fill{position:absolute;left:0;top:0;height:100%;background:#fff;border-radius:2px;transition:width .3s}

  /* Endpoints */
  .endpoints {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 1rem;
    padding: 1.5rem;
    margin-bottom: 3rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  .endpoints h2 {
    font-family: 'Inter', sans-serif;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #737373;
    margin-bottom: 0.75rem;
    font-weight: 500;
  }
  .endpoint {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0;
    color: #a3a3a3;
  }
  .method {
    font-weight: 500;
    min-width: 3rem;
  }
  .method.get { color: #a3a3a3; }
  .method.post { color: #a3a3a3; }
  .endpoint-path { color: #e5e5e5; }
  .endpoint-desc { color: #525252; margin-left: auto; font-family: 'Inter', sans-serif; font-size: 0.75rem; }

  /* Categories */
  .category {
    margin-bottom: 2rem;
  }
  .category-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid #1c1c1c;
  }
  .category-icon {
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(74,222,128,0.1);
    border-radius: 0.5rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    font-weight: 600;
    color: #4ade80;
    border: 1px solid rgba(74,222,128,0.2);
  }
  .category-header h2 {
    font-size: 0.8rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #a3a3a3;
  }
  .category-count {
    font-size: 0.7rem;
    color: #525252;
    background: #1c1c1c;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    font-variant-numeric: tabular-nums;
  }

  /* Provider cards */
  .provider {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 0.75rem;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0.75rem;
    transition: all 0.2s ease;
  }
  .provider:hover {
    border-color: rgba(74,222,128,0.4);
    background: rgba(74,222,128,0.02);
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    transform: translateY(-1px);
  }
  .provider-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.5rem;
  }
  .provider-title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .provider-title h3 {
    font-size: 0.95rem;
    font-weight: 500;
    color: #fff;
  }
  .provider-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: #525252;
  }
  .provider-desc {
    font-size: 0.8rem;
    color: #737373;
    margin-bottom: 1rem;
  }

  /* Badges */
  .badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.2rem 0.6rem;
    border-radius: 1rem;
  }
  .badge.live {
    background: rgba(255, 255, 255, 0.06);
    color: #a3a3a3;
    border: 1px solid #333;
  }
  .badge.no-key {
    background: rgba(255, 255, 255, 0.03);
    color: #525252;
    border: 1px solid #262626;
  }

  /* Actions */
  .actions-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .action {
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.03);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .action code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #d4d4d4;
    font-weight: 400;
  }
  .action-desc {
    font-size: 0.75rem;
    color: #525252;
    margin-left: 0.75rem;
  }
  .params {
    margin-top: 0.375rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .param {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    padding: 0.15rem 0.5rem;
    background: #1c1c1c;
    border-radius: 0.25rem;
    color: #737373;
  }
  .param.required {
    color: #a3a3a3;
    background: #1c1c1c;
  }

  /* Footer */
  footer {
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid #1c1c1c;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  footer span {
    font-size: 0.75rem;
    color: #404040;
  }
  footer a {
    font-size: 0.75rem;
    color: #525252;
    text-decoration: none;
    transition: color 0.15s;
  }
  footer a:hover { color: #a3a3a3; }

  /* Usage panel */
  .usage-panel {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2.5rem;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  }
  .usage-panel h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #737373;
    margin-bottom: 1rem;
    font-weight: 500;
  }
  .usage-meta {
    display: flex;
    gap: 2rem;
    margin-bottom: 1rem;
    font-size: 0.8rem;
    color: #737373;
  }
  .usage-meta span { color: #a3a3a3; }
  .quota-bar-outer {
    width: 100%;
    height: 6px;
    background: #1c1c1c;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .quota-bar-inner {
    height: 100%;
    background: #4ade80;
    border-radius: 3px;
    transition: width 0.3s;
  }
  .quota-bar-inner.warn { background: #a3a3a3; }
  .quota-bar-inner.critical { background: #737373; }
  .usage-numbers {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #525252;
    margin-bottom: 1.25rem;
  }
  .usage-numbers span { font-variant-numeric: tabular-nums; }
  .usage-breakdown {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .usage-chip {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    padding: 0.25rem 0.75rem;
    background: #0a0a0a;
    border-radius: 0.375rem;
    color: #737373;
  }
  .usage-chip .chip-count {
    color: #d4d4d4;
    margin-left: 0.375rem;
  }
  .usage-login {
    background: #111;
    border: 1px solid #262626;
    border-radius: 0.75rem;
    padding: 1.25rem 1.5rem;
    margin-bottom: 2.5rem;
    font-size: 0.8rem;
    color: #525252;
  }
  .usage-login code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: #a3a3a3;
    background: #1c1c1c;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 2rem;
    border-bottom: 1px solid #262626;
  }
  .tab {
    padding: 0.75rem 1.5rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: #525252;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tab:hover { color: #fff; }
  .tab.active { color: #4ade80; border-bottom-color: #4ade80; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Admin */
  .admin-login {
    background: #111;
    border: 1px solid #262626;
    border-radius: 0.75rem;
    padding: 1.5rem;
    max-width: 380px;
  }
  .admin-login h2 {
    font-size: 0.85rem;
    font-weight: 500;
    color: #e5e5e5;
    margin-bottom: 0.75rem;
  }
  .admin-login input {
    width: 100%;
    background: #0a0a0a;
    border: 1px solid #262626;
    border-radius: 0.5rem;
    padding: 0.6rem 1rem;
    color: #e5e5e5;
    font-size: 0.85rem;
    font-family: 'JetBrains Mono', monospace;
    outline: none;
    margin-bottom: 0.75rem;
    transition: border-color 0.15s;
  }
  .admin-login input:focus { border-color: #525252; }
  .admin-login button {
    background: #e5e5e5;
    color: #0a0a0a;
    border: none;
    border-radius: 0.5rem;
    padding: 0.6rem 1.5rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .admin-login button:hover { background: #fff; }
  .admin-error {
    color: #f87171;
    font-size: 0.75rem;
    margin-top: 0.5rem;
  }

  .accounts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .accounts-table th {
    text-align: left;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #525252;
    font-weight: 500;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #262626;
  }
  .accounts-table td {
    padding: 0.75rem;
    border-bottom: 1px solid #1c1c1c;
    color: #a3a3a3;
    vertical-align: middle;
  }
  .accounts-table tr:hover td { background: #111; }
  .key-cell {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    cursor: pointer;
    color: #737373;
    transition: color 0.15s;
  }
  .key-cell:hover { color: #e5e5e5; }
  .key-cell .copy-hint {
    font-family: 'Inter', sans-serif;
    font-size: 0.6rem;
    color: #404040;
    margin-left: 0.5rem;
  }
  .mini-bar {
    width: 80px;
    height: 4px;
    background: #1c1c1c;
    border-radius: 2px;
    overflow: hidden;
    display: inline-block;
    vertical-align: middle;
    margin-right: 0.5rem;
  }
  .mini-bar-inner {
    height: 100%;
    background: #d4d4d4;
    border-radius: 2px;
  }
  .mini-bar-inner.warn { background: #a3a3a3; }
  .mini-bar-inner.critical { background: #737373; }
  .tier-badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.15rem 0.5rem;
    border-radius: 1rem;
    background: rgba(255,255,255,0.06);
    color: #a3a3a3;
    border: 1px solid #333;
  }

  /* Create key form */
  .create-key {
    background: #111;
    border: 1px solid #262626;
    border-radius: 0.75rem;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  .create-key h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #737373;
    margin-bottom: 1rem;
    font-weight: 500;
  }
  .create-key-form {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .form-field label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #525252;
  }
  .form-field input, .form-field select {
    background: #0a0a0a;
    border: 1px solid #262626;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    color: #e5e5e5;
    font-size: 0.8rem;
    outline: none;
    transition: border-color 0.15s;
  }
  .form-field input:focus, .form-field select:focus { border-color: #525252; }
  .form-field select { cursor: pointer; }
  .create-btn {
    background: #e5e5e5;
    color: #0a0a0a;
    border: none;
    border-radius: 0.375rem;
    padding: 0.5rem 1.25rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    height: fit-content;
  }
  .create-btn:hover { background: #fff; }

  /* Flash */
  .flash {
    background: rgba(255,255,255,0.04);
    border: 1px solid #333;
    border-radius: 0.5rem;
    padding: 1rem 1.25rem;
    margin-bottom: 1.5rem;
    display: none;
  }
  .flash.visible { display: block; }
  .flash-label {
    font-size: 0.7rem;
    color: #525252;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.375rem;
  }
  .flash-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
    color: #e5e5e5;
    cursor: pointer;
    word-break: break-all;
  }
  .flash-key:hover { color: #fff; }
  .flash-sub {
    font-size: 0.7rem;
    color: #404040;
    margin-top: 0.375rem;
  }

  .copied-toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    background: #e5e5e5;
    color: #0a0a0a;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
  }
  .copied-toast.show { opacity: 1; }

  @media (max-width: 640px) {
    .stats { flex-direction: column; }
    .endpoint-desc { display: none; }
    .provider-title { flex-direction: column; gap: 0.125rem; }
    .create-key-form { flex-direction: column; }
    .accounts-table { font-size: 0.7rem; }
  }
</style>
</head>
<body>
<script>if(!document.cookie.match(/pl_key=/))window.location.href='/login';</script>
<nav style="border-bottom:1px solid #1c1c1c;padding:1rem 0"><div style="max-width:960px;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center">
  <a href="/" style="font-weight:600;color:#fff;font-size:0.95rem;text-decoration:none">procurement labs</a>
  <div style="display:flex;gap:1.5rem;font-size:0.8rem">
    <a href="/how-it-works" style="color:#525252;text-decoration:none">How It Works</a>
    <a href="/dashboard" style="color:#e5e5e5;text-decoration:none">Dashboard</a>
  </div>
</div></nav>
<div class="container">
  <header>
    <h1>Dashboard</h1>
    <p>${total} providers across ${Object.keys(grouped).length} categories</p>
  </header>

  <div class="tabs">
    <div class="tab active" data-tab="home">Usage</div>
    <div class="tab" data-tab="admin">Admin</div>
  </div>

  <!-- Home Tab -->
  <div id="tab-home" class="tab-content active">
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${total}</div>
        <div class="stat-label">Total Providers</div>
      </div>
      <div class="stat">
        <div class="stat-value green">${live}</div>
        <div class="stat-label">Live</div>
      </div>
      <div class="stat">
        <div class="stat-value amber">${total - live}</div>
        <div class="stat-label">Needs API Key</div>
      </div>
      <div class="stat">
        <div class="stat-value">${noKey}</div>
        <div class="stat-label">Free (No Key)</div>
      </div>
    </div>

    <!-- Usage: logged-in state -->
    <div id="usage-logged-in" class="usage-panel" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2 id="usage-title" style="margin:0"></h2>
        <div style="display:flex;align-items:center;gap:1rem">
          <button id="usage-key-display" style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:#a3a3a3;cursor:pointer;background:#1c1c1c;border:1px solid #262626;border-radius:0.375rem;padding:0.3rem 0.75rem;transition:border-color .15s" title="Click to copy full key"></button>
          <button id="usage-signout" style="background:none;border:1px solid #262626;border-radius:0.375rem;padding:0.3rem 0.75rem;color:#525252;font-size:0.7rem;cursor:pointer;transition:color .15s">sign out</button>
        </div>
      </div>
      <div class="usage-meta">
        <div>Quota: <span id="usage-quota-text"></span></div>
        <div>Rate limit: <span id="usage-rate-text"></span></div>
        <div>Resets: <span id="usage-resets-text"></span></div>
      </div>
      <div class="quota-bar-outer">
        <div class="quota-bar-inner" id="usage-bar"></div>
      </div>
      <div class="usage-numbers">
        <span id="usage-remaining-text"></span>
        <span id="usage-pct-text"></span>
      </div>
      <div class="usage-breakdown" id="usage-breakdown"></div>
    </div>

    <!-- Smart Routing Stats -->
    <div id="routing-panel" class="usage-panel" style="display:none">
      <h2>Smart Routing</h2>
      <div class="routing-stats">
        <div class="routing-stat">
          <div class="routing-stat-value" id="routing-total">0</div>
          <div class="routing-stat-label">Total Routed</div>
        </div>
        <div class="routing-stat">
          <div class="routing-stat-value" id="routing-fallbacks">0</div>
          <div class="routing-stat-label">Auto-Fallbacks</div>
        </div>
        <div class="routing-stat">
          <div class="routing-stat-value" id="routing-smart">0</div>
          <div class="routing-stat-label">Smart Routes</div>
        </div>
      </div>
      <div id="routing-providers" style="margin-top:1rem"></div>
    </div>

    <div class="endpoints">
      <h2>Endpoints</h2>
      <div class="endpoint"><span class="method get">GET</span><span class="endpoint-path">/api/providers</span><span class="endpoint-desc">list available providers</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="endpoint-path">/api/query</span><span class="endpoint-desc">execute a provider action</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="endpoint-path">/api/mcp</span><span class="endpoint-desc">MCP protocol (JSON-RPC)</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="endpoint-path">/api/usage</span><span class="endpoint-desc">check quota and usage breakdown</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="endpoint-path">/api/recommend</span><span class="endpoint-desc">AI-powered provider recommendations</span></div>
    </div>

    ${categoryCards}
  </div>

  <!-- Admin Tab -->
  <div id="tab-admin" class="tab-content">
    <div id="admin-login" class="admin-login">
      <h2>Admin Access</h2>
      <input type="password" id="admin-pass" placeholder="password" autocomplete="off">
      <button id="admin-login-btn">Unlock</button>
      <div id="admin-error" class="admin-error"></div>
    </div>

    <div id="admin-panel" style="display:none">
      <div id="key-flash" class="flash">
        <div class="flash-label">New key created — click to copy</div>
        <div id="flash-key" class="flash-key"></div>
        <div class="flash-sub">This is the only time the full key is shown.</div>
      </div>

      <div class="create-key">
        <h2>Create Key</h2>
        <div class="create-key-form">
          <div class="form-field">
            <label>Email (optional)</label>
            <input type="text" id="key-email" placeholder="user@example.com">
          </div>
          <div class="form-field">
            <label>Tier</label>
            <select id="key-tier">
              <option value="free">free</option>
              <option value="pro">pro</option>
              <option value="unlimited">unlimited</option>
            </select>
          </div>
          <div class="form-field">
            <label>Monthly Quota</label>
            <input type="number" id="key-quota" value="500" min="1" style="width:100px">
          </div>
          <div class="form-field">
            <label>Rate (req/min)</label>
            <input type="number" id="key-rate" value="10" min="1" style="width:80px">
          </div>
          <button class="create-btn" id="create-key-btn">Create</button>
        </div>
      </div>

      <table class="accounts-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Email</th>
            <th>Tier</th>
            <th>Usage</th>
            <th>Quota</th>
            <th>Rate</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody id="accounts-body"></tbody>
      </table>
    </div>
  </div>

  <footer>
    <span>procurement labs v0.1.0</span>
    <a href="https://github.com/tobasummandal/procurementlabs">github</a>
  </footer>
</div>

<div class="copied-toast" id="copied-toast">Copied</div>

<script>
(function() {
  let adminPass = null;

  // Cookie helpers
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, val) {
    document.cookie = name + '=' + encodeURIComponent(val) + '; path=/; max-age=' + (365*86400) + '; samesite=lax';
  }
  function deleteCookie(name) {
    document.cookie = name + '=; path=/; max-age=0';
  }

  // Mask key
  function maskKey(key) {
    if (key.length <= 10) return key;
    return key.slice(0, 6) + '...' + key.slice(-4);
  }

  // Usage rendering
  function showUsagePanel(u, key) {
    document.getElementById('usage-title').textContent = 'Your Usage — ' + u.tier + ' tier';
    document.getElementById('usage-key-display').textContent = maskKey(key) + '  copy';
    document.getElementById('usage-quota-text').textContent = u.used + ' / ' + u.quota;
    document.getElementById('usage-rate-text').textContent = (u.per_minute_rate || 10) + ' req/min';
    document.getElementById('usage-resets-text').textContent = u.resets;
    const pct = Math.min(100, (u.used / u.quota) * 100);
    const bar = document.getElementById('usage-bar');
    bar.style.width = pct + '%';
    bar.className = 'quota-bar-inner' + (pct > 90 ? ' critical' : pct > 70 ? ' warn' : '');
    document.getElementById('usage-remaining-text').textContent = u.remaining + ' remaining';
    document.getElementById('usage-pct-text').textContent = Math.round(pct) + '% used';
    document.getElementById('usage-breakdown').innerHTML = (u.breakdown || []).map(function(b) {
      return '<span class="usage-chip">' + b.provider + '<span class="chip-count">' + b.count + '</span></span>';
    }).join('');
    document.getElementById('usage-logged-in').style.display = 'block';
  }

  async function fetchUsage(key) {
    const res = await fetch('/api/usage', { headers: { 'x-pl-key': key } });
    if (!res.ok) return null;
    return await res.json();
  }

  // Fetch and render routing stats
  async function loadRoutingStats(key) {
    try {
      var res = await fetch('/api/routing-stats', { headers: { 'x-pl-key': key } });
      if (!res.ok) return;
      var stats = await res.json();
      if (stats.total === 0) return;
      document.getElementById('routing-total').textContent = stats.total;
      document.getElementById('routing-fallbacks').textContent = stats.fallbacks;
      document.getElementById('routing-smart').textContent = stats.smartRoutes;
      var maxCount = stats.byProvider.length ? stats.byProvider[0].count : 1;
      document.getElementById('routing-providers').innerHTML = stats.byProvider.map(function(p) {
        var pct = Math.round((p.count / maxCount) * 100);
        return '<div class="routing-provider"><span class="name">' + p.provider + '</span><div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div><span class="count">' + p.count + '</span></div>';
      }).join('');
      document.getElementById('routing-panel').style.display = 'block';
    } catch(e) {}
  }

  // Auto-load from cookie
  const savedKey = getCookie('pl_key');
  if (savedKey) {
    fetchUsage(savedKey).then(u => {
      if (u) showUsagePanel(u, savedKey);
      else { deleteCookie('pl_key'); window.location.href = '/login'; }
    }).catch(() => {});
    loadRoutingStats(savedKey);
  }

  // Copy full key from logged-in display
  document.getElementById('usage-key-display').addEventListener('click', function() {
    var el = this;
    var key = getCookie('pl_key');
    if (!key) return;
    navigator.clipboard.writeText(key).then(function() {
      el.textContent = 'copied!';
      setTimeout(function() { el.textContent = maskKey(key) + '  copy'; }, 1500);
    });
  });

  // Sign out → redirect to login
  document.getElementById('usage-signout').addEventListener('click', () => {
    deleteCookie('pl_key');
    window.location.href = '/login';
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Copy to clipboard
  function copyKey(key) {
    navigator.clipboard.writeText(key);
    const toast = document.getElementById('copied-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1200);
  }

  // Mask key: pl_abcd...wxyz
  function maskKey(key) {
    if (key.length <= 10) return key;
    return key.slice(0, 6) + '...' + key.slice(-4);
  }

  // Usage bar class
  function barClass(used, quota) {
    const r = used / quota;
    if (r > 0.9) return 'critical';
    if (r > 0.7) return 'warn';
    return '';
  }

  // Render accounts table
  function renderAccounts(accounts) {
    const tbody = document.getElementById('accounts-body');
    tbody.innerHTML = accounts.map(a => {
      const pct = Math.min(100, (a.used / a.quota) * 100);
      const cls = barClass(a.used, a.quota);
      const date = new Date(a.createdAt).toLocaleDateString();
      return '<tr>'
        + '<td class="key-cell" data-key="' + a.key + '" title="Click to copy">' + maskKey(a.key) + '<span class="copy-hint">copy</span></td>'
        + '<td>' + (a.email || '<span style="color:#404040">—</span>') + '</td>'
        + '<td><span class="tier-badge">' + a.tier + '</span></td>'
        + '<td><span class="mini-bar"><span class="mini-bar-inner ' + cls + '" style="width:' + pct + '%"></span></span>' + a.used + ' / ' + a.quota + '</td>'
        + '<td>' + a.remaining + ' left</td>'
        + '<td>' + a.perMinuteRate + '/min</td>'
        + '<td style="color:#525252">' + date + '</td>'
        + '</tr>';
    }).join('');
  }

  // Click-to-copy on key cells
  document.getElementById('accounts-body').addEventListener('click', e => {
    const cell = e.target.closest('.key-cell');
    if (cell) copyKey(cell.dataset.key);
  });

  // Admin login
  document.getElementById('admin-login-btn').addEventListener('click', tryLogin);
  document.getElementById('admin-pass').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  async function tryLogin() {
    const pass = document.getElementById('admin-pass').value;
    const errEl = document.getElementById('admin-error');
    errEl.textContent = '';
    try {
      const res = await fetch('/api/admin/accounts', { headers: { 'x-admin-pass': pass } });
      if (!res.ok) { errEl.textContent = 'Wrong password'; return; }
      adminPass = pass;
      const data = await res.json();
      document.getElementById('admin-login').style.display = 'none';
      document.getElementById('admin-panel').style.display = 'block';
      renderAccounts(data.accounts);
    } catch (e) { errEl.textContent = 'Connection error'; }
  }

  // Create key
  document.getElementById('create-key-btn').addEventListener('click', async () => {
    const btn = document.getElementById('create-key-btn');
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-pass': adminPass },
        body: JSON.stringify({
          email: document.getElementById('key-email').value || undefined,
          tier: document.getElementById('key-tier').value,
          monthly_quota: Number(document.getElementById('key-quota').value),
          per_minute_rate: Number(document.getElementById('key-rate').value),
        }),
      });
      if (!res.ok) { alert('Failed to create key'); return; }
      const data = await res.json();
      // Show flash
      const flash = document.getElementById('key-flash');
      const flashKey = document.getElementById('flash-key');
      flashKey.textContent = data.account.key;
      flashKey.onclick = () => copyKey(data.account.key);
      flash.classList.add('visible');
      // Clear form
      document.getElementById('key-email').value = '';
      document.getElementById('key-tier').value = 'free';
      document.getElementById('key-quota').value = '500';
      document.getElementById('key-rate').value = '10';
      // Reload accounts
      const acRes = await fetch('/api/admin/accounts', { headers: { 'x-admin-pass': adminPass } });
      if (acRes.ok) { const d = await acRes.json(); renderAccounts(d.accounts); }
    } catch (e) { alert('Error: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = 'Create'; }
  });
})();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const [path, qs] = (req.url || "").split("?");

  // ── OAuth endpoints ────────────────────────────────────────────────────────
  if (path === "/.well-known/oauth-authorization-server") {
    const base = getBaseUrl(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }));
  }

  if (path === "/register" && req.method === "POST") {
    const regBody = await parseBody(req);
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      client_id: crypto.randomBytes(16).toString("hex"),
      redirect_uris: regBody.redirect_uris ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }));
  }

  if (path === "/authorize") {
    if (req.method === "GET") {
      const params = querystring.parse(qs || "");
      const get = (k: string) => (Array.isArray(params[k]) ? params[k]![0] : params[k] as string) ?? "";
      if (get("response_type") !== "code") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "unsupported_response_type" }));
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderAuthorizeForm({
        clientId: get("client_id"), redirectUri: get("redirect_uri"),
        state: get("state"), codeChallenge: get("code_challenge"),
        codeChallengeMethod: get("code_challenge_method") || "S256",
      }));
    }
    if (req.method === "POST") {
      const body = await parseFormBody(req);
      const { client_id, redirect_uri, state, code_challenge, code_challenge_method, api_key } = body;
      const account = await getAccount(api_key);
      if (!account) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(renderAuthorizeForm({
          clientId: client_id ?? "", redirectUri: redirect_uri ?? "",
          state: state ?? "", codeChallenge: code_challenge ?? "",
          codeChallengeMethod: code_challenge_method ?? "S256",
          error: "Invalid API key. Check your key and try again.",
        }));
      }
      const code = crypto.randomBytes(20).toString("hex");
      pendingCodes.set(code, {
        apiKey: api_key, redirectUri: redirect_uri ?? "",
        codeChallenge: code_challenge ?? "", expiresAt: Date.now() + 5 * 60_000,
      });
      const callback = new URL(redirect_uri ?? "");
      if (state) callback.searchParams.set("state", state);
      callback.searchParams.set("code", code);
      res.writeHead(302, {
        Location: callback.toString(),
        "Set-Cookie": `pl_key=${api_key}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`,
      });
      return res.end();
    }
  }

  if (path === "/token" && req.method === "POST") {
    const body = await parseFormBody(req);
    const { grant_type, code, redirect_uri, code_verifier } = body;
    if (grant_type !== "authorization_code") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "unsupported_grant_type" }));
    }
    const pending = code ? pendingCodes.get(code) : undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      pendingCodes.delete(code ?? "");
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Code expired or not found" }));
    }
    if (pending.redirectUri !== redirect_uri || !code_verifier || !verifyPKCE(code_verifier, pending.codeChallenge)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE or redirect_uri mismatch" }));
    }
    pendingCodes.delete(code!);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ access_token: pending.apiKey, token_type: "bearer" }));
  }

  // ── API routes ─────────────────────────────────────────────────────────────
  const body = await parseBody(req);

  // Lift Bearer token → x-pl-key so existing handlers validate it transparently
  const authHeader = req.headers["authorization"];
  if (authHeader?.toLowerCase().startsWith("bearer ") && !req.headers["x-pl-key"]) {
    (req.headers as any)["x-pl-key"] = authHeader.slice(7);
  }

  const fakeReq: any = {
    method: req.method,
    headers: req.headers,
    url: req.url,
    query: querystring.parse(qs || ""),
    body,
  };

  const fakeRes = makeRes(res);

  // ── Pages ───────────────────────────────────────────────────────────────
  if (path === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderHomepage());
  }

  if (path === "/how-it-works") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderHowItWorks());
  }

  if (path === "/login") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderLogin());
  }

  if (path === "/dashboard") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(renderDashboard());
  }

  if (path === "/api/health") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ status: "ok", providers: getHealthData() }));
  }

  if (path === "/api/providers") return providersHandler(fakeReq, fakeRes);
  if (path === "/api/query") return queryHandler(fakeReq, fakeRes);
  if (path === "/api/recommend") return recommendHandler(fakeReq, fakeRes);
  if (path === "/api/mcp") {
    // Authenticate
    const plKey = req.headers["x-pl-key"] as string;
    if (!plKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing x-pl-key header" }));
    }
    const account = await getAccount(plKey);
    if (!account) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid API key" }));
    }

    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && mcpSessions.has(sessionId)) {
      return mcpSessions.get(sessionId)!.transport.handleRequest(req, res, body);
    }

    // New session (must be initialize request or POST without session)
    if (req.method === "POST") {
      const session = await createMcpSession(account.id);
      await session.transport.handleRequest(req, res, body);
      // Store session after initialize sets the session ID
      if (session.transport.sessionId) {
        mcpSessions.set(session.transport.sessionId, session);
      }
      return;
    }

    // GET for SSE stream on existing session
    if (req.method === "GET" && sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Session not found" }));
    }

    // DELETE to close session
    if (req.method === "DELETE" && sessionId && mcpSessions.has(sessionId)) {
      const session = mcpSessions.get(sessionId)!;
      await session.transport.close();
      mcpSessions.delete(sessionId);
      res.writeHead(200);
      return res.end();
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (path === "/api/usage") return usageHandler(fakeReq, fakeRes);

  // ── Admin API ────────────────────────────────────────────────────────────
  const adminPass = process.env.ADMIN_PASSWORD || "mantis-shrimp";
  const checkAdmin = () => req.headers["x-admin-pass"] === adminPass;

  if (path === "/api/admin/accounts" && req.method === "GET") {
    if (!checkAdmin()) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid admin password" }));
    }
    const accounts = await getAllAccounts();
    const withUsage = await Promise.all(accounts.map(async (a) => {
      const breakdown = await getUsage(a.id);
      const used = breakdown.reduce((sum, r) => sum + r.count, 0);
      return {
        key: a.pl_key,
        email: a.email,
        tier: a.tier,
        quota: a.monthly_quota,
        used,
        remaining: Math.max(0, a.monthly_quota - used),
        perMinuteRate: a.per_minute_rate,
        createdAt: a.created_at,
      };
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ accounts: withUsage }));
  }

  if (path === "/api/admin/keys" && req.method === "POST") {
    if (!checkAdmin()) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid admin password" }));
    }
    const plKey = "pl_" + crypto.randomBytes(12).toString("hex");
    const account = await createAccount({
      plKey,
      email: body.email,
      tier: body.tier,
      monthlyQuota: body.monthly_quota ? Number(body.monthly_quota) : undefined,
      perMinuteRate: body.per_minute_rate ? Number(body.per_minute_rate) : undefined,
    });
    if (!account) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to create account" }));
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ account: { key: account.pl_key, email: account.email, tier: account.tier, quota: account.monthly_quota, perMinuteRate: account.per_minute_rate } }));
  }

  // ── Public signup ─────────────────────────────────────────────────────────
  if (path === "/api/signup" && req.method === "POST") {
    const email = (body.email || "").trim();
    if (!email || !email.includes("@")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Valid email is required" }));
    }
    const plKey = "pl_" + crypto.randomBytes(12).toString("hex");
    const account = await createAccount({ plKey, email });
    if (!account) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to create account" }));
    }
    res.writeHead(201, {
      "Content-Type": "application/json",
      "Set-Cookie": `pl_key=${plKey}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ key: plKey, tier: account.tier, quota: account.monthly_quota }));
  }

  if (path === "/api/routing-stats" && req.method === "GET") {
    const plKey = req.headers["x-pl-key"] as string;
    const isAdmin = req.headers["x-admin-pass"] === adminPass;
    if (!plKey && !isAdmin) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing x-pl-key or x-admin-pass" }));
    }
    let stats;
    if (isAdmin) {
      stats = await getRoutingStats();
    } else {
      const account = await getAccount(plKey);
      if (!account) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid key" }));
      }
      stats = await getRoutingStats(account.id);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(stats));
  }

  if (path === "/api/signin-email" && req.method === "POST") {
    const email = (body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Valid email is required" }));
    }
    const account = await getAccountByEmail(email);
    if (!account) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "No account found for this email" }));
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `pl_key=${account.pl_key}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (path === "/api/waitlist" && req.method === "POST") {
    const email = (body.email || "").trim();
    if (!email || !email.includes("@")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Valid email is required" }));
    }
    const ok = await addToWaitlist(email);
    if (!ok) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Already on the list" }));
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`dev server running on http://localhost:${PORT}`);
});
