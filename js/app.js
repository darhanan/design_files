import { REPO, MANIFEST, CATEGORIES, DESIGNS_DIR, UNSORTED } from "./config.js";
import { GitHub, bytesToBase64 } from "./github.js";
import { analyze, classify, slugify } from "./classify.js";

const MAX_SIZE = 50 * 1024 * 1024;
const TOKEN_KEY = "design-files:token";
const PREVIEW_HASH = "#view=gallery&theme=light";

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = {
  categories: [],
  designs: [],
  filter: "all",
  query: "",
  local: new Map(), // id -> html uploaded in this session, shown until GitHub Pages has the file
  fresh: new Set(), // ids uploaded in this session
  busy: new Set(),
  token: store.get(TOKEN_KEY) || "",
  login: "",
  pendingFiles: null,
};
let gh = new GitHub(state.token);

// ── Data ──────────────────────────────────────────────

async function fetchJson(path, fallback) {
  // With a token read straight from the repo (always fresh); otherwise from the published site.
  if (state.token) {
    try { return await gh.readJson(path, REPO.branch, fallback); } catch (e) { console.warn(e); }
  }
  try {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? await res.json() : fallback;
  } catch { return fallback; }
}

async function load() {
  const [cats, manifest] = await Promise.all([fetchJson(CATEGORIES, []), fetchJson(MANIFEST, { designs: [] })]);
  state.categories = cats;
  state.designs = manifest.designs || [];
  render();
  openFromHash();
}

const allCategories = () => [...state.categories, UNSORTED];
const categoryOf = id => allCategories().find(c => c.id === id) || UNSORTED;

// ── Rendering ─────────────────────────────────────────

const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]])
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "только что";
}
const PLATFORM_LABEL = { ios: "iOS", android: "Android", web: "Web" };

function matches(d) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [d.name, d.originalName, categoryOf(d.category).name, ...(d.screens || [])].some(s => s && s.toLowerCase().includes(q));
}

// Cards are kept and reused across renders: re-creating or moving an iframe reloads its preview,
// so search and filters only hide things, and data changes touch just the cards that changed.
const cards = new Map(); // id -> card element
const sectionsEl = new Map(); // category id -> section element

function render() {
  $("#total").textContent = state.designs.length ? `· ${state.designs.length}` : "";
  const main = $("#main");
  main.querySelector(".loading")?.remove();

  let empty = main.querySelector(".empty");
  if (!state.designs.length && !empty) {
    main.insertAdjacentHTML("afterbegin", `
      <div class="empty" data-action="upload" role="button" tabindex="0">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h2>Загрузите первый дизайн</h2>
        <p>Перетащите HTML-файлы сюда или нажмите. Категория определится автоматически.</p>
      </div>`);
  } else if (state.designs.length && empty) empty.remove();

  const cats = allCategories();
  for (const [id, el] of sectionsEl) if (!cats.some(c => c.id === id)) { el.remove(); sectionsEl.delete(id); }
  const live = new Set(state.designs.map(d => d.id));
  for (const [id, el] of cards) if (!live.has(id)) { el.remove(); cards.delete(id); }

  let prev = null;
  for (const cat of cats) {
    let sec = sectionsEl.get(cat.id);
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "section";
      sec.innerHTML = `<div class="section-head"></div><div class="grid"></div><div class="empty-note" hidden>Ничего не найдено</div>`;
      sectionsEl.set(cat.id, sec);
    }
    if ((prev ? prev.nextElementSibling : main.querySelector(".section")) !== sec) prev ? prev.after(sec) : main.append(sec);
    prev = sec;
    sec.id = `cat-${cat.id}`;
    const topics = (cat.topics || []).join(" · ");
    sec.querySelector(".section-head").innerHTML = `
      <span class="pill${cat.id === UNSORTED.id ? " gray" : ""}">${esc(cat.name)}</span>
      ${topics ? `<span class="section-topics">${esc(topics)}</span>` : ""}
      <span class="section-count"></span>`;

    const grid = sec.querySelector(".grid");
    const items = state.designs.filter(d => d.category === cat.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    items.forEach((d, i) => {
      const el = cardFor(d);
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
  }
  applyFilter();
}

function cardFor(d) {
  let el = cards.get(d.id);
  if (!el) {
    el = document.createElement("article");
    el.className = "card";
    el.tabIndex = 0;
    el.dataset.id = d.id;
    el.innerHTML = `<div class="thumb"></div><div class="meta"></div>`;
    cards.set(d.id, el);
    sizer.observe(el.querySelector(".thumb"));
  }
  el.classList.toggle("busy", state.busy.has(d.id));
  const thumb = el.querySelector(".thumb");
  const version = d.updatedAt + (state.local.has(d.id) ? ":local" : "");
  if (el.dataset.v !== version) {
    el.dataset.v = version;
    thumb.innerHTML = `${state.fresh.has(d.id) ? `<span class="badge-new">Новый</span>` : ""}<div class="placeholder">Загружаю превью…</div>`;
    lazy.observe(thumb);
  }
  const meta = metaHtml(d);
  if (el.querySelector(".meta").innerHTML !== meta) el.querySelector(".meta").innerHTML = meta;
  return el;
}

function metaHtml(d) {
  const platforms = (d.platforms || []).map(p => PLATFORM_LABEL[p] || p).join(", ");
  const sub = [platforms, ago(d.updatedAt), d.by && `@${d.by}`].filter(Boolean).join(" · ");
  return `<span class="file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 7 3 12l5 5M16 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg></span><div class="info"><div class="name" title="${esc(d.name)}">${esc(d.name)}</div><div class="sub" title="${esc(sub)}">${esc(sub)}</div></div><button class="btn ghost icon-only more" data-menu="${esc(d.id)}" aria-label="Действия"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"></circle><circle cx="12" cy="12" r="1.8" fill="currentColor"></circle><circle cx="19" cy="12" r="1.8" fill="currentColor"></circle></svg></button>`;
}

// Search and the category chips only show and hide what is already on the page.
function applyFilter() {
  const visible = state.designs.filter(matches);
  const shown = new Set(visible.map(d => d.id));
  for (const [id, el] of cards) el.hidden = !shown.has(id);

  const counts = {};
  for (const d of visible) counts[d.category] = (counts[d.category] || 0) + 1;
  for (const cat of allCategories()) {
    const sec = sectionsEl.get(cat.id);
    const n = counts[cat.id] || 0;
    const selected = state.filter === cat.id;
    sec.hidden = !state.designs.length || !(selected || (state.filter === "all" && n));
    sec.querySelector(".section-count").textContent = n;
    sec.querySelector(".empty-note").hidden = !!n;
    sec.querySelector(".empty-note").textContent = state.query ? "Ничего не найдено" : "В этой категории пока пусто";
  }
  let note = $("#main > .empty-note");
  const nothing = state.designs.length && state.filter === "all" && !visible.length;
  if (nothing && !note) $("#main").insertAdjacentHTML("beforeend", `<div class="empty-note">Ничего не найдено</div>`);
  else if (!nothing && note) note.remove();

  const chips = [{ id: "all", name: "Все", n: visible.length }, ...allCategories().map(c => ({ ...c, n: counts[c.id] || 0 }))]
    .filter(c => c.id !== UNSORTED.id || c.n || state.filter === UNSORTED.id);
  $("#chips").innerHTML = chips
    .map(c => `<button class="chip${state.filter === c.id ? " active" : ""}" data-filter="${esc(c.id)}">${esc(c.name)} <span class="n">${c.n}</span></button>`)
    .join("");
}

const fileUrl = d => `${d.file}?v=${encodeURIComponent(d.updatedAt)}`;

// Previews are live, scaled-down pages; each loads once it scrolls near the screen.
const sizer = new ResizeObserver(entries => {
  for (const e of entries) e.target.style.setProperty("--scale", e.contentRect.width / 1000);
});
const lazy = new IntersectionObserver(
  entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    lazy.unobserve(e.target);
    const d = state.designs.find(x => x.id === e.target.closest(".card").dataset.id);
    if (d) mountPreview(e.target, d);
  }),
  { rootMargin: "400px" },
);

function mountPreview(thumb, d) {
  thumb.querySelector("iframe")?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("aria-hidden", "true");
  if (state.local.has(d.id)) frame.srcdoc = state.local.get(d.id);
  else frame.src = fileUrl(d) + PREVIEW_HASH;
  frame.addEventListener("load", () => thumb.querySelector(".placeholder")?.remove(), { once: true });
  thumb.appendChild(frame);
}

// ── Viewer ────────────────────────────────────────────

function openViewer(d) {
  $("#viewer-title").textContent = d.name;
  const frame = $("#viewer-frame");
  if (state.local.has(d.id)) { frame.removeAttribute("src"); frame.srcdoc = state.local.get(d.id); }
  else { frame.removeAttribute("srcdoc"); frame.src = fileUrl(d); }
  $("#viewer-download").href = d.file;
  $("#viewer-download").setAttribute("download", d.originalName || `${d.id}.html`);
  $("#viewer-newtab").href = d.file;
  const sel = $("#viewer-category");
  sel.innerHTML = allCategories().map(c => `<option value="${esc(c.id)}"${c.id === d.category ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  sel.dataset.id = d.id;
  $("#viewer").hidden = false;
  document.body.style.overflow = "hidden";
  if (location.hash !== `#d=${d.id}`) history.pushState(null, "", `#d=${encodeURIComponent(d.id)}`);
}

function closeViewer(push = true) {
  $("#viewer").hidden = true;
  $("#viewer-frame").removeAttribute("srcdoc");
  $("#viewer-frame").src = "about:blank";
  document.body.style.overflow = "";
  if (push && location.hash) history.pushState(null, "", location.pathname + location.search);
}

function openFromHash() {
  const id = decodeURIComponent((location.hash.match(/^#d=(.+)$/) || [])[1] || "");
  const d = id && state.designs.find(x => x.id === id);
  if (d) openViewer(d);
  else if (!$("#viewer").hidden) closeViewer(false);
}
window.addEventListener("popstate", openFromHash);

// ── Toasts ────────────────────────────────────────────

function toast(text, { kind = "", spinner = false, action, timeout = 5000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${spinner ? `<span class="spinner"></span>` : ""}<span class="t"></span>`;
  el.querySelector(".t").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// ── Writing to the repo ───────────────────────────────

function needToken(files) {
  if (state.token) return false;
  state.pendingFiles = files || null;
  openSettings("Чтобы загружать и менять дизайны, подключите GitHub-токен — это нужно сделать один раз.");
  return true;
}

async function saveManifest(message, update, extra = {}) {
  const results = await gh.commit({ message, ...extra, json: { [MANIFEST]: m => update(m || { designs: [] }) } });
  state.designs = results[MANIFEST].designs;
  render();
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  const html = files.filter(f => /\.html?$/i.test(f.name) || f.type === "text/html");
  const skipped = files.length - html.length;
  if (skipped) toast(`Пропущено файлов: ${skipped} — загружать можно только .html`, { kind: "err" });
  const tooBig = html.filter(f => f.size > MAX_SIZE);
  if (tooBig.length) toast(`Слишком большой файл (больше 50 МБ): ${tooBig.map(f => f.name).join(", ")}`, { kind: "err" });
  const ok = html.filter(f => f.size <= MAX_SIZE);
  if (!ok.length || needToken(ok)) return;

  const progress = toast(ok.length === 1 ? `Загружаю «${ok[0].name}»…` : `Загружаю ${ok.length} файла…`, { spinner: true, timeout: 0 });
  try {
    const now = new Date().toISOString();
    const items = await Promise.all(
      ok.map(async f => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        const info = analyze(text, f.name);
        const { category } = classify(info, state.categories);
        const id = slugify(f.name);
        return { id, text, base64: bytesToBase64(bytes), info, category, f };
      }),
    );
    // Two files with the same name in one batch: keep the last one.
    const byId = new Map(items.map(i => [i.id, i]));
    const batch = [...byId.values()];
    // Show the uploaded copy right away; GitHub Pages needs a minute to publish the file.
    for (const it of batch) { state.local.set(it.id, it.text); state.fresh.add(it.id); }

    await saveManifest(
      batch.length === 1 ? `Upload ${batch[0].f.name}` : `Upload ${batch.length} designs`,
      m => {
        for (const it of batch) {
          const prev = m.designs.find(d => d.id === it.id);
          const entry = {
            id: it.id,
            name: prev && !prev.autoName ? prev.name : it.info.name,
            autoName: prev ? prev.autoName : true,
            originalName: it.f.name,
            file: `${DESIGNS_DIR}/${it.id}.html`,
            // A category someone picked by hand survives re-uploads; an auto one is re-detected.
            category: prev && !prev.autoCategory ? prev.category : it.category,
            autoCategory: prev ? prev.autoCategory : true,
            platforms: it.info.platforms,
            screens: it.info.screens,
            size: it.f.size,
            createdAt: prev?.createdAt || now,
            updatedAt: now,
            by: state.login || prev?.by || "",
          };
          m.designs = prev ? m.designs.map(d => (d.id === it.id ? entry : d)) : [...m.designs, entry];
        }
        return m;
      },
      { files: batch.map(it => ({ path: `${DESIGNS_DIR}/${it.id}.html`, base64: it.base64 })) },
    );

    progress.remove();
    for (const it of batch) {
      const d = state.designs.find(x => x.id === it.id);
      const cat = categoryOf(d.category);
      toast(`«${d.name}» → ${cat.name}`, {
        action: { label: "Изменить", run: () => { const card = document.querySelector(`.card[data-id="${CSS.escape(d.id)}"]`); if (card) openMenu(d.id, card.querySelector(".more")); } },
        timeout: 8000,
      });
    }
    document.querySelector(`.card[data-id="${CSS.escape(batch[0].id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    for (const f of ok) { const id = slugify(f.name); state.local.delete(id); state.fresh.delete(id); }
    progress.remove();
    toast(`Не загрузилось: ${e.message}`, { kind: "err", timeout: 10000 });
  }
}

async function mutate(id, message, change, extra) {
  if (needToken()) return;
  state.busy.add(id);
  render();
  try {
    await saveManifest(message, m => ({ ...m, designs: change(m.designs) }), extra);
  } catch (e) {
    toast(`Не сохранилось: ${e.message}`, { kind: "err", timeout: 10000 });
  } finally {
    state.busy.delete(id);
    render();
  }
}

const setCategory = (id, category) =>
  mutate(id, `Move ${id} to ${category}`, ds => ds.map(d => (d.id === id ? { ...d, category, autoCategory: false } : d)));

function rename(id) {
  const d = state.designs.find(x => x.id === id);
  const name = prompt("Новое название", d.name)?.trim();
  if (!name || name === d.name) return;
  mutate(id, `Rename ${id}`, ds => ds.map(x => (x.id === id ? { ...x, name, autoName: false } : x)));
}

function remove(id) {
  const d = state.designs.find(x => x.id === id);
  if (!confirm(`Удалить «${d.name}»? Файл уберётся из репозитория (останется в истории git).`)) return;
  mutate(id, `Delete ${id}`, ds => ds.filter(x => x.id !== id), { remove: [d.file] });
}

// ── Card menu ─────────────────────────────────────────

function openMenu(id, anchor) {
  const d = state.designs.find(x => x.id === id);
  if (!d) return;
  const menu = $("#menu");
  menu.innerHTML = `
    <button data-act="open">Открыть</button>
    <a href="${esc(d.file)}" download="${esc(d.originalName || d.id + ".html")}">Скачать</a>
    <button data-act="rename">Переименовать</button>
    <hr><div class="label">Категория</div>
    ${allCategories().map(c => `<button data-cat="${esc(c.id)}"><span class="check">${c.id === d.category ? "✓" : ""}</span>${esc(c.name)}</button>`).join("")}
    <hr><button data-act="delete" class="danger">Удалить</button>`;
  menu.dataset.id = id;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  menu.style.top = (r.bottom + h + 8 < innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + "px";
}
const closeMenu = () => ($("#menu").hidden = true);

$("#menu").addEventListener("click", e => {
  const id = $("#menu").dataset.id;
  const b = e.target.closest("button, a");
  if (!b) return;
  closeMenu();
  if (b.dataset.cat) { if (b.dataset.cat !== state.designs.find(d => d.id === id)?.category) setCategory(id, b.dataset.cat); }
  else if (b.dataset.act === "open") openViewer(state.designs.find(d => d.id === id));
  else if (b.dataset.act === "rename") rename(id);
  else if (b.dataset.act === "delete") remove(id);
});
document.addEventListener("click", e => { if (!e.target.closest("#menu, [data-menu]")) closeMenu(); });
window.addEventListener("scroll", closeMenu, { passive: true });

// ── Settings ──────────────────────────────────────────

function openSettings(reason) {
  $("#token-reason").textContent = reason || "Смотреть дизайны может кто угодно по ссылке. Чтобы загружать, нужен GitHub-токен с доступом к репозиторию — вводится один раз и хранится только в этом браузере.";
  $("#token").value = state.token;
  const status = $("#token-status");
  status.className = "status" + (state.login ? " ok" : "");
  status.textContent = state.login ? `Подключено как @${state.login}` : "";
  renderCatEditor();
  $("#settings").showModal();
}

$("#repo-link").href = `https://github.com/${REPO.owner}/${REPO.name}/settings/access`;
$("#repo-link").textContent = `${REPO.owner}/${REPO.name}`;

$("#token-save").addEventListener("click", async () => {
  const token = $("#token").value.trim();
  const status = $("#token-status");
  if (!token) {
    state.token = ""; state.login = ""; gh = new GitHub(""); store.set(TOKEN_KEY, null);
    status.className = "status"; status.textContent = "Токен удалён";
    return;
  }
  status.className = "status"; status.textContent = "Проверяю…";
  try {
    const probe = new GitHub(token);
    const { login, canPush } = await probe.check();
    if (!canPush) throw new Error(`у @${login} нет права записи в ${REPO.owner}/${REPO.name}`);
    state.token = token; state.login = login; gh = probe; store.set(TOKEN_KEY, token);
    status.className = "status ok"; status.textContent = `Подключено как @${login}`;
    if (state.pendingFiles) {
      const files = state.pendingFiles;
      state.pendingFiles = null;
      $("#settings").close();
      uploadFiles(files);
    }
  } catch (e) {
    status.className = "status err";
    status.textContent = e.status === 401 ? "Токен не подошёл — проверьте, что скопировали целиком" : `Ошибка: ${e.message}`;
  }
});

let catDraft = [];
function renderCatEditor() {
  catDraft = state.categories.map(c => ({ ...c }));
  drawCatEditor();
}
function drawCatEditor() {
  $("#cat-editor").innerHTML = catDraft
    .map((c, i) => `
      <div class="cat-row" data-i="${i}">
        <input class="input" data-k="name" value="${esc(c.name)}" placeholder="Название">
        <button class="btn ghost icon-only" type="button" data-del="${i}" title="Удалить категорию" aria-label="Удалить категорию"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
        <textarea data-k="words" placeholder="Темы и ключевые слова через запятую">${esc([...(c.topics || []), ...(c.keywords || [])].join(", "))}</textarea>
      </div>`)
    .join("");
}
$("#cat-editor").addEventListener("input", e => {
  const row = e.target.closest(".cat-row");
  const c = catDraft[row.dataset.i];
  if (e.target.dataset.k === "name") c.name = e.target.value;
  else {
    // Words that were topics stay topics (shown on the section header); new ones become keywords.
    const words = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    const topics = new Set((c.topics || []).map(t => t.toLowerCase()));
    c.topics = words.filter(w => topics.has(w.toLowerCase()));
    c.keywords = words.filter(w => !topics.has(w.toLowerCase()));
  }
});
$("#cat-editor").addEventListener("click", e => {
  const i = e.target.closest("[data-del]")?.dataset.del;
  if (i == null) return;
  const c = catDraft[i];
  const used = state.designs.filter(d => d.category === c.id).length;
  if (used && !confirm(`В «${c.name}» ${used} дизайн(ов) — они попадут в «${UNSORTED.name}». Удалить категорию?`)) return;
  catDraft.splice(i, 1);
  drawCatEditor();
});
$("#cat-add").addEventListener("click", () => {
  catDraft.push({ id: "", name: "", topics: [], keywords: [] });
  drawCatEditor();
  $("#cat-editor .cat-row:last-child input").focus();
});
$("#cat-save").addEventListener("click", async () => {
  if (needToken()) return;
  const taken = new Set();
  const cats = catDraft
    .filter(c => c.name.trim())
    .map(c => {
      let id = c.id || slugify(c.name) || "category";
      while (taken.has(id) || (!c.id && state.categories.some(x => x.id === id))) id += "-2";
      taken.add(id);
      return { id, name: c.name.trim(), topics: c.topics || [], keywords: c.keywords || [] };
    });
  const ids = new Set(cats.map(c => c.id));
  const btn = $("#cat-save");
  btn.disabled = true;
  try {
    const results = await gh.commit({
      message: "Update categories",
      json: {
        [CATEGORIES]: () => cats,
        [MANIFEST]: m => ({ ...(m || {}), designs: (m?.designs || []).map(d => (ids.has(d.category) ? d : { ...d, category: UNSORTED.id })) }),
      },
    });
    state.categories = results[CATEGORIES];
    state.designs = results[MANIFEST].designs;
    if (state.filter !== "all" && !ids.has(state.filter)) state.filter = "all";
    render();
    $("#settings").close();
    toast("Категории сохранены");
  } catch (e) {
    toast(`Не сохранилось: ${e.message}`, { kind: "err", timeout: 10000 });
  } finally {
    btn.disabled = false;
  }
});

// ── Events ────────────────────────────────────────────

const input = $("#file-input");
const pickFiles = () => (state.token ? input.click() : needToken() || input.click());
$("#upload-btn").addEventListener("click", pickFiles);
input.addEventListener("change", () => { if (input.files.length) uploadFiles(input.files); input.value = ""; });
$("#open-settings").addEventListener("click", () => openSettings());

$("#search").addEventListener("input", e => { state.query = e.target.value.trim(); applyFilter(); });
$("#chips").addEventListener("click", e => {
  const c = e.target.closest("[data-filter]");
  if (!c) return;
  state.filter = c.dataset.filter;
  applyFilter();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("#main").addEventListener("click", e => {
  if (e.target.closest("[data-action=upload]")) return pickFiles();
  const more = e.target.closest("[data-menu]");
  if (more) { e.stopPropagation(); return $("#menu").hidden || $("#menu").dataset.id !== more.dataset.menu ? openMenu(more.dataset.menu, more) : closeMenu(); }
  const card = e.target.closest(".card");
  if (card) openViewer(state.designs.find(d => d.id === card.dataset.id));
});
$("#main").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.target.closest("[data-menu]")) return;
  if (e.target.closest("[data-action=upload]")) return pickFiles();
  const card = e.target.closest(".card");
  if (card) openViewer(state.designs.find(d => d.id === card.dataset.id));
});

$("#viewer-close").addEventListener("click", () => closeViewer());
$("#viewer-category").addEventListener("change", e => setCategory(e.target.dataset.id, e.target.value));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#menu").hidden) closeMenu();
  else if (!$("#viewer").hidden) closeViewer();
});

// Drag & drop anywhere on the page.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#drop-overlay").hidden = false; });
window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; } });
window.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  uploadFiles(e.dataTransfer.files);
});

// Pick up teammates' uploads when coming back to the tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("#viewer").hidden && !$("#settings").open) load();
});

if (state.token) gh.check().then(r => (state.login = r.login)).catch(() => {});
load();
