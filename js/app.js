import { REPO, MANIFEST, CATEGORIES, DESIGNS_DIR, UNSORTED } from "./config.js";
import { GitHub, bytesToBase64 } from "./github.js";
import { analyze, classify, slugify } from "./classify.js";

const MAX_SIZE = 50 * 1024 * 1024;
const PASSWORD_KEY = "design-files:password";
const AUTHOR_KEY = "design-files:author";
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
  token: store.get(PASSWORD_KEY) || "", // team password for the upload proxy
  author: store.get(AUTHOR_KEY) || "",
};
let gh = new GitHub(state.token);
store.set("design-files:token", null); // earlier versions kept a raw GitHub token here

function setPassword(password) {
  state.token = password;
  gh = new GitHub(password);
  store.set(PASSWORD_KEY, password || null);
}
function setAuthor(name) {
  state.author = name;
  store.set(AUTHOR_KEY, name || null);
}

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
  const sub = [platforms, ago(d.updatedAt), d.by].filter(Boolean).join(" · ");
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
  // Never open the raw file directly: it would run on this origin and could read the token.
  $("#viewer-newtab").href = `view.html?f=${encodeURIComponent(d.file)}&v=${encodeURIComponent(d.updatedAt)}`;
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

function needToken() {
  if (state.token) return false;
  openSettings("Чтобы менять дизайны и категории, введите пароль команды — это нужно сделать один раз.");
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
  if (!ok.length) return;

  try {
    const items = await Promise.all(
      ok.map(async f => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        const info = analyze(text, f.name);
        const auto = classify(info, state.categories).category;
        // Re-uploading the same file name updates that design, whatever its id was derived from.
        const id = state.designs.find(d => d.originalName === f.name)?.id || slugify(f.name);
        const prev = state.designs.find(d => d.id === id);
        return {
          id, text, base64: bytesToBase64(bytes), info, auto, prev, f,
          // A name or category someone picked by hand survives re-uploads; auto ones are re-detected.
          name: prev && !prev.autoName ? prev.name : info.name,
          category: prev && !prev.autoCategory ? prev.category : auto,
        };
      }),
    );
    // Two files with the same name in one batch: keep the last one.
    openConfirm([...new Map(items.map(i => [i.id, i])).values()]);
  } catch (e) {
    toast(`Не удалось прочитать файл: ${e.message}`, { kind: "err", timeout: 10000 });
  }
}

// ── Upload confirmation ───────────────────────────────

let confirmItems = [];

function categoryHint(it) {
  if (it.category === it.auto) return "Категория · определена автоматически";
  if (it.prev && !it.prev.autoCategory && it.category === it.prev.category) return "Категория · выбрана вручную раньше";
  return `Категория · выбрана вручную (авто — ${categoryOf(it.auto).name})`;
}

function openConfirm(items) {
  confirmItems = items;
  $("#confirm-title").textContent = items.length === 1 ? "Загрузка дизайна" : `Загрузка дизайнов: ${items.length}`;
  const options = allCategories().map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("#confirm-list").innerHTML = items
    .map((it, i) => {
      const platforms = it.info.platforms.map(p => PLATFORM_LABEL[p] || p).join(", ");
      return `
      <div class="confirm-item" data-i="${i}">
        <div class="thumb"><div class="placeholder">Загружаю превью…</div></div>
        <div class="confirm-fields">
          <label class="field">
            <span>Название${it.prev ? ` <b class="tag">обновит существующий</b>` : ""}</span>
            <input class="input" data-k="name" value="${esc(it.name)}">
          </label>
          <label class="field">
            <span class="cat-hint">${esc(categoryHint(it))}</span>
            <select class="select" data-k="category">${options}</select>
          </label>
          <div class="file-line">${esc([it.f.name, platforms].filter(Boolean).join(" · "))}</div>
        </div>
      </div>`;
    })
    .join("");
  $("#confirm-list").querySelectorAll(".confirm-item").forEach((row, i) => {
    row.querySelector("select").value = items[i].category;
    const thumb = row.querySelector(".thumb");
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("tabindex", "-1");
    frame.srcdoc = items[i].text;
    frame.addEventListener("load", () => thumb.querySelector(".placeholder")?.remove(), { once: true });
    thumb.appendChild(frame);
    sizer.observe(thumb);
  });

  $("#confirm-password").value = "";
  $("#confirm-password").closest(".field").hidden = !!state.token;
  $("#confirm-author").value = state.author;
  $("#confirm-author").closest(".field").hidden = !!state.author;
  $("#confirm-auth").hidden = !!state.token && !!state.author;
  $("#confirm-status").textContent = "";
  $("#confirm").showModal();
  $("#confirm-ok").focus();
}

$("#confirm-list").addEventListener("input", e => {
  const row = e.target.closest(".confirm-item");
  const it = confirmItems[row.dataset.i];
  if (e.target.dataset.k === "name") it.name = e.target.value;
  if (e.target.dataset.k === "category") {
    it.category = e.target.value;
    row.querySelector(".cat-hint").textContent = categoryHint(it);
  }
});
$("#confirm").addEventListener("close", () => { $("#confirm-list").innerHTML = ""; });

$("#confirm-ok").addEventListener("click", async () => {
  const status = $("#confirm-status");
  const btn = $("#confirm-ok");
  status.textContent = "";
  const unnamed = confirmItems.findIndex(it => !it.name.trim());
  if (unnamed !== -1) {
    status.textContent = "Укажите название";
    $(`#confirm-list [data-i="${unnamed}"] input`).focus();
    return;
  }
  if (!state.token) {
    const password = $("#confirm-password").value.trim();
    if (!password) { status.textContent = "Введите пароль команды"; $("#confirm-password").focus(); return; }
    btn.disabled = true;
    try {
      await new GitHub(password).check();
      setPassword(password);
    } catch (e) {
      status.textContent = e.status === 401 ? "Неверный пароль команды" : `Ошибка: ${e.message}`;
      return;
    } finally {
      btn.disabled = false;
    }
  }
  const author = $("#confirm-author").value.trim();
  if (author) setAuthor(author);
  const items = confirmItems;
  $("#confirm").close();
  saveUploads(items);
});

async function saveUploads(batch) {
  const progress = toast(batch.length === 1 ? `Загружаю «${batch[0].name}»…` : `Загружаю ${batch.length} дизайна…`, { spinner: true, timeout: 0 });
  try {
    const now = new Date().toISOString();
    // Show the uploaded copy right away; GitHub Pages needs a minute to publish the file.
    for (const it of batch) { state.local.set(it.id, it.text); state.fresh.add(it.id); }

    await saveManifest(
      batch.length === 1 ? `Upload ${batch[0].f.name}` : `Upload ${batch.length} designs`,
      m => {
        for (const it of batch) {
          const prev = m.designs.find(d => d.id === it.id);
          const name = it.name.trim();
          const entry = {
            id: it.id,
            name,
            autoName: name === it.info.name,
            originalName: it.f.name,
            file: `${DESIGNS_DIR}/${it.id}.html`,
            category: it.category,
            autoCategory: it.category === it.auto,
            platforms: it.info.platforms,
            screens: it.info.screens,
            size: it.f.size,
            createdAt: prev?.createdAt || now,
            updatedAt: now,
            by: state.author || prev?.by || "",
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
      toast(`«${d.name}» загружен в «${cat.name}»`, { timeout: 6000 });
    }
    document.querySelector(`.card[data-id="${CSS.escape(batch[0].id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    for (const it of batch) { state.local.delete(it.id); state.fresh.delete(it.id); }
    progress.remove();
    if (e.status === 401) setPassword(""); // password changed: ask again next time
    toast(`Не загрузилось: ${e.status === 401 ? "неверный пароль команды" : e.message}`, { kind: "err", timeout: 10000 });
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
  $("#token-reason").textContent = reason || "Смотреть дизайны может кто угодно по ссылке. Чтобы загружать и менять, нужен пароль команды — вводится один раз и хранится только в этом браузере.";
  $("#token").value = state.token;
  $("#author").value = state.author;
  const status = $("#token-status");
  status.className = "status" + (state.token ? " ok" : "");
  status.textContent = state.token ? "Пароль сохранён — можно загружать" : "";
  renderCatEditor();
  $("#settings").showModal();
}

$("#author").addEventListener("change", e => setAuthor(e.target.value.trim()));

$("#token-save").addEventListener("click", async () => {
  const password = $("#token").value.trim();
  const status = $("#token-status");
  if (!password) {
    setPassword("");
    status.className = "status"; status.textContent = "Пароль удалён из этого браузера";
    return;
  }
  status.className = "status"; status.textContent = "Проверяю…";
  try {
    await new GitHub(password).check();
    setPassword(password);
    status.className = "status ok"; status.textContent = "Пароль сохранён — можно загружать";
  } catch (e) {
    status.className = "status err";
    status.textContent = e.status === 401 ? "Неверный пароль команды" : `Ошибка: ${e.message}`;
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
const pickFiles = () => input.click();
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

load();
