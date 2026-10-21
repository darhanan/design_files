// Upload proxy for Design Files. Holds the GitHub token so designers only need the team password.
// It forwards a small set of GitHub API calls, and only for this one repo and branch.
//
// Secrets (wrangler secret put …): GITHUB_TOKEN, TEAM_PASSWORD. Vars in wrangler.toml: REPO, BRANCH, ORIGINS.

const GITHUB = "https://api.github.com";

function allowed(method, rest, env) {
  const branch = env.BRANCH;
  if (method === "GET")
    return rest === "" || /^\/contents\/[\w./-]+$/.test(rest) || rest === `/git/ref/heads/${branch}` || /^\/git\/commits\/[0-9a-f]{40}$/.test(rest);
  if (method === "POST") return ["/git/blobs", "/git/trees", "/git/commits"].includes(rest);
  if (method === "PATCH") return rest === `/git/refs/heads/${branch}`;
  return false;
}

// Compare without leaking the password length or prefix through timing.
async function samePassword(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const origins = env.ORIGINS.split(",").map(s => s.trim());
    const okOrigin = origins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : origins[0],
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const reply = (status, body) => Response.json(body, { status, headers: cors });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return reply(403, { message: "Forbidden origin" });
    if (!env.TEAM_PASSWORD || !env.GITHUB_TOKEN) return reply(503, { message: "Сервер загрузки ещё не настроен" });

    const password = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!password || !(await samePassword(password, env.TEAM_PASSWORD))) return reply(401, { message: "Неверный пароль команды" });

    const url = new URL(request.url);
    if (url.pathname === "/check") return reply(200, { ok: true });

    const prefix = `/repos/${env.REPO}`;
    if (!(url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) return reply(404, { message: "Not found" });
    const rest = url.pathname.slice(prefix.length);
    if (!allowed(request.method, rest, env)) return reply(403, { message: "Not allowed" });

    let body;
    if (request.method !== "GET") {
      body = await request.text();
      // Never let the proxy rewrite history.
      if (request.method === "PATCH" && JSON.parse(body).force) return reply(403, { message: "Force push is not allowed" });
    }

    const res = await fetch(GITHUB + url.pathname + url.search, {
      method: request.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "design-files-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
    });
    // GitHub rejecting our token is the owner's problem, not a wrong team password.
    if (res.status === 401) return reply(502, { message: "Ключ GitHub на сервере не работает — напишите владельцу" });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
    });
  },
};
