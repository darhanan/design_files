// Minimal GitHub API client (through the upload proxy): reads JSON from the repo and writes several files in one commit.
import { REPO, API } from "./config.js";
const repoPath = `/repos/${REPO.owner}/${REPO.name}`;

const utf8ToBase64 = s => bytesToBase64(new TextEncoder().encode(s));
const base64ToUtf8 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHub {
  // `password` is the team password; the proxy swaps it for the real GitHub token.
  constructor(password) {
    this.token = password;
  }

  async api(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // Throws with status 401 when the team password is wrong.
  async check() {
    await this.api("/check");
  }

  async headSha() {
    return (await this.api(`${repoPath}/git/ref/heads/${REPO.branch}`)).object.sha;
  }

  async readJson(path, ref = REPO.branch, fallback = null) {
    try {
      const file = await this.api(`${repoPath}/contents/${path}?ref=${ref}`);
      return JSON.parse(base64ToUtf8(file.content));
    } catch (e) {
      if (e.status === 404) return fallback;
      throw e;
    }
  }

  async blob(base64) {
    return (await this.api(`${repoPath}/git/blobs`, { method: "POST", body: { content: base64, encoding: "base64" } })).sha;
  }

  /**
   * One commit on the branch:
   *  - `files`: [{ path, base64 }] added or replaced
   *  - `remove`: [path] deleted
   *  - `json`: { path: (current) => next } read-modify-write of JSON files, re-run if someone pushed meanwhile
   */
  async commit({ message, files = [], remove = [], json = {} }) {
    const uploaded = await Promise.all(files.map(async f => ({ path: f.path, sha: await this.blob(f.base64) })));
    for (let attempt = 0; attempt < 5; attempt++) {
      const parent = await this.headSha();
      const baseTree = (await this.api(`${repoPath}/git/commits/${parent}`)).tree.sha;
      const results = {};
      const tree = [
        ...uploaded.map(f => ({ path: f.path, mode: "100644", type: "blob", sha: f.sha })),
        ...remove.map(path => ({ path, mode: "100644", type: "blob", sha: null })),
      ];
      for (const [path, update] of Object.entries(json)) {
        results[path] = update(await this.readJson(path, parent));
        const sha = await this.blob(utf8ToBase64(JSON.stringify(results[path], null, 2) + "\n"));
        tree.push({ path, mode: "100644", type: "blob", sha });
      }
      const newTree = await this.api(`${repoPath}/git/trees`, { method: "POST", body: { base_tree: baseTree, tree } });
      const commit = await this.api(`${repoPath}/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents: [parent] } });
      try {
        await this.api(`${repoPath}/git/refs/heads/${REPO.branch}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
        return results;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e; // someone else pushed first: rebuild on top of theirs
      }
    }
    throw new Error("Не удалось сохранить: репозиторий меняется слишком часто, попробуйте ещё раз");
  }
}
