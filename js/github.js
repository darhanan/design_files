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

function httpError(status, message) {
  const err = new Error(`GitHub ${status}: ${message}`);
  err.status = status;
  return err;
}

const abortError = () => Object.assign(new Error("Загрузка отменена"), { name: "AbortError" });

export class GitHub {
  // `password` is the team password; the proxy swaps it for the real GitHub token.
  constructor(password) {
    this.token = password;
  }

  async api(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw httpError(res.status, (await res.json().catch(() => ({}))).message || res.statusText);
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

  // XHR rather than fetch: only XHR reports upload progress.
  blob(base64, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}${repoPath}/git/blobs`);
      xhr.setRequestHeader("Accept", "application/vnd.github+json");
      xhr.setRequestHeader("Content-Type", "application/json");
      if (this.token) xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.sha);
        else reject(httpError(xhr.status, body.message || xhr.statusText));
      };
      xhr.onerror = () => reject(new Error("Нет соединения с сервером загрузки"));
      xhr.onabort = () => reject(abortError());
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(JSON.stringify({ content: base64, encoding: "base64" }));
    });
  }

  /**
   * One commit on the branch:
   *  - `files`: [{ path, base64, onProgress? }] added or replaced
   *  - `signal`: aborting it before the branch moves leaves the repo untouched
   *  - `remove`: [path] deleted
   *  - `json`: { path: (current) => next } read-modify-write of JSON files, re-run if someone pushed meanwhile
   */
  async commit({ message, files = [], remove = [], json = {}, signal }) {
    const uploaded = await Promise.all(files.map(async f => ({ path: f.path, sha: await this.blob(f.base64, { onProgress: f.onProgress, signal }).then(sha => (f.onProgress?.(1), sha)) })));
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
      if (signal?.aborted) throw abortError();
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
