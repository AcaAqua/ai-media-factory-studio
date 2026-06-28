let state = null;
let mappingCandidates = null;
let activeMapping = {};
let selectedAsset = null;
let recipeSourceAsset = null;
let selectedCompareAssets = new Set();
let activeRecipe = null;
let libraryFiltersReady = false;
let activeScopeTab = "sfw";
let pendingRecipeId = "";
let activeComparisonId = "";
let boardAssets = [];
let boardLoaded = false;
let civitaiConfig = null;
let promptTranslation = { terms: [], presets: [], history: [], last: null };
let assetRegistry = { locations: [], items: [], scan_runs: [] };
let setupStatus = null;
let databaseBackups = [];
let activeAssetRegistryItem = null;
let lastCivitaiLookup = null;
let lastDownloadedAssetId = "";
let activeCivitaiDownloadJobId = "";

const FIELD_LABELS = {
  positive_prompt: "Positive Prompt",
  negative_prompt: "Negative Prompt",
  seed: "Seed",
  width: "Width",
  height: "Height",
  steps: "Steps",
  cfg: "CFG",
  sampler: "Sampler",
  scheduler: "Scheduler",
  checkpoint: "Checkpoint / Model",
  lora: "LoRA",
  output: "出力ノード",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function load() {
  state = await api("/api/bootstrap");
  promptTranslation = {
    ...promptTranslation,
    ...(state.prompt_translation || {}),
    last: promptTranslation.last,
  };
  assetRegistry = state.asset_registry || assetRegistry;
  await loadCivitaiConfig().catch(() => { civitaiConfig = null; });
  await loadSetupStatus().catch(() => { setupStatus = null; });
  render();
}

function render() {
  renderStatus();
  renderWorkflows();
  renderRecipeSelect();
  renderLibraryFilters();
  renderJobs();
  renderAssets();
  renderComparisons();
  renderBoardFilters();
  renderBoard();
  renderRecipes();
  renderModels();
  renderSettings();
  renderDiagnostics();
  renderStorage();
  renderMappingTable();
  renderAssetLinkPreview();
  renderPromptTranslation();
  updateScopeWarning();
}

function renderStatus() {
  const strip = $("#statusStrip");
  const { comfyui, ollama } = state.connections;
  const git = state.git;
  const queueCount = state.jobs.filter((job) => ["submitted", "running"].includes(job.status)).length;
  strip.innerHTML = [
    chip(`ComfyUI ${comfyui.ok ? "●" : "×"}`, comfyui.ok ? "ok" : "bad"),
    chip(`Ollama ${ollama.ok ? "●" : "×"}`, ollama.ok ? "ok" : "bad"),
    chip(`Queue ${queueCount}`, queueCount ? "warn" : ""),
    chip(`Git ${git.ok ? "●" : "未確認"}`, git.ok ? "ok" : "warn"),
  ].join("");
}

function chip(text, level = "") {
  return `<span class="chip ${level}">${escapeHtml(text)}</span>`;
}

function renderWorkflows() {
  const select = $("#workflowSelect");
  const current = select.value;
  const registered = state.workflows.map((workflow) => ({
    label: `登録済み: ${workflow.name}`,
    value: workflow.workflow_id,
  }));
  const discovered = state.discovered_workflows
    .filter((item) => !state.workflows.some((workflow) => workflow.relative_path === item.relative_path))
    .map((item) => ({ label: `未登録: ${item.relative_path}`, value: `discover:${item.relative_path}` }));
  select.innerHTML = `<option value="">Workflowなしで履歴保存</option>` + [...registered, ...discovered]
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderRecipeSelect() {
  const select = $("#recipeSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">レシピを選択</option>` + (state.recipes || [])
    .filter((recipe) => recipe.status !== "archived")
    .map((recipe) => `<option value="${escapeHtml(recipe.recipe_id)}">${escapeHtml(recipe.name)}</option>`)
    .join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderLibraryFilters() {
  if (!$("#filterStatus")) return;
  const current = {
    status: $("#filterStatus").value,
    rating: $("#filterRating").value,
    tags: [...($("#filterTags")?.selectedOptions || [])].map((option) => option.value),
    workflow: $("#filterWorkflow").value,
    recipe: $("#filterRecipe").value,
    period: $("#filterPeriod").value,
    scope: $("#filterScope").value,
  };
  $("#filterStatus").innerHTML = [
    ["", "すべて"],
    ["draft", "draft"],
    ["candidate", "candidate"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["archived", "archived"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#filterRating").innerHTML = [
    ["", "すべて"],
    ["1", "1以上"],
    ["2", "2以上"],
    ["3", "3以上"],
    ["4", "4以上"],
    ["5", "5"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#filterTags").innerHTML = `<option value="untagged">タグ未設定</option>` + (state.tags || [])
    .map((tag) => `<option value="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</option>`)
    .join("");
  $("#filterWorkflow").innerHTML = `<option value="">すべて</option>` + state.workflows
    .map((workflow) => `<option value="${escapeHtml(workflow.workflow_id)}">${escapeHtml(workflow.name)}</option>`)
    .join("");
  $("#filterRecipe").innerHTML = `<option value="">すべて</option>` + (state.recipes || [])
    .filter((recipe) => recipe.status !== "archived")
    .map((recipe) => `<option value="${escapeHtml(recipe.recipe_id)}">${escapeHtml(recipe.name)}</option>`)
    .join("");
  $("#filterPeriod").innerHTML = [
    ["", "すべて"],
    ["today", "今日"],
    ["week", "7日"],
    ["month", "30日"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#filterScope").innerHTML = [
    ["", "すべて"],
    ["sfw", "SFW"],
    ["sensitive", "Sensitive"],
    ["adult_local", "Adult Local"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#filterStatus").value = current.status;
  $("#filterRating").value = current.rating;
  [...$("#filterTags").options].forEach((option) => { option.selected = current.tags.includes(option.value); });
  $("#filterWorkflow").value = current.workflow;
  $("#filterRecipe").value = current.recipe;
  $("#filterPeriod").value = current.period;
  $("#filterScope").value = current.scope;
  libraryFiltersReady = true;
}

function adultStorageConfigured() {
  return (state.storage || []).some(
    (item) => item.content_scope === "adult_local"
      && item.is_enabled
      && item.is_available
      && item.writable
      && item.is_comfy_output_compatible
  );
}

function adultStorageStatus() {
  const adult = (state.storage || []).find((item) => item.content_scope === "adult_local" && item.is_enabled);
  if (!adult) return { ok: false, label: "Adult Local保存先が未設定です" };
  if (!adult.path_exists) return { ok: false, label: "Adult Local保存先: 未接続" };
  if (!adult.writable) return { ok: false, label: "Adult Local保存先: 書込不可" };
  if (!adult.is_comfy_output_compatible) return { ok: false, label: "Adult Local保存先: 出力ルート外" };
  return { ok: true, label: `Adult Local保存先: 利用可能 (${adult.comfy_output_relative_path || "."})` };
}

function setScopeTab(scope) {
  activeScopeTab = scope;
  $$(".scope-tabs .filter").forEach((button) => button.classList.toggle("active", button.dataset.scopeTab === scope));
  if ($("#filterScope")) $("#filterScope").value = scope;
  selectedCompareAssets.clear();
  searchAssets().catch((error) => alert(error.message));
}

async function searchAssets(quick = "") {
  const params = new URLSearchParams();
  const query = $("#assetSearch").value.trim();
  if (query) params.set("query", query);
  for (const [key, selector] of [
    ["status", "#filterStatus"],
    ["rating", "#filterRating"],
    ["workflow_id", "#filterWorkflow"],
    ["recipe_id", "#filterRecipe"],
    ["period", "#filterPeriod"],
  ]) {
    const value = $(selector)?.value;
    if (value) params.set(key, value);
  }
  params.set("content_scope", activeScopeTab);
  const tags = [...($("#filterTags")?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
  if (tags.length) params.set("tags", tags.join(","));
  if (quick) params.set("quick", quick);
  const result = await api(`/api/assets?${params.toString()}`);
  state.assets = result.assets;
  renderAssets();
}

function clearLibraryFilters() {
  $("#assetSearch").value = "";
  for (const selector of ["#filterStatus", "#filterRating", "#filterWorkflow", "#filterRecipe", "#filterPeriod"]) {
    const control = $(selector);
    if (control) control.value = "";
  }
  if ($("#filterTags")) [...$("#filterTags").options].forEach((option) => { option.selected = false; });
  $$(".quick-filters .filter").forEach((button) => button.classList.remove("active"));
  searchAssets().catch((error) => alert(error.message));
}

function updateCompareCount() {
  const count = selectedCompareAssets.size;
  if ($("#compareCount")) $("#compareCount").textContent = `${count}件選択`;
  if ($("#openCompare")) $("#openCompare").disabled = count < 2 || count > 8;
}

function toggleCompareSelection(assetId, checked) {
  if (checked && selectedCompareAssets.size >= 8) {
    alert("比較は最大8枚までです。");
    renderAssets();
    return;
  }
  if (checked) selectedCompareAssets.add(assetId);
  else selectedCompareAssets.delete(assetId);
  renderAssets();
}

function openCompareView() {
  const assets = state.assets.filter((asset) => selectedCompareAssets.has(asset.asset_id));
  if (assets.length < 2) {
    alert("比較する画像を2枚以上選択してください。");
    return;
  }
  const scopes = new Set(assets.map((asset) => asset.content_scope || "sfw"));
  if (scopes.size > 1 && !confirm("異なる区分の画像が含まれています。このまま比較しますか？")) return;
  closeAssetDetail();
  $("#compareName").value = `Comparison ${new Date().toLocaleString()}`;
  $("#compareMemo").value = "";
  $("#compareResult").value = "";
  $("#compareImprove").value = "";
  $("#compareGrid").innerHTML = assets.map((asset) => compareCardHtml(asset)).join("");
  $("#compareView").classList.add("open");
  $("#compareView").setAttribute("aria-hidden", "false");
}

function compareCardHtml(asset) {
  const params = safeJson(asset.parameters_json);
  return `
    <article class="compare-card" data-compare-asset="${escapeHtml(asset.asset_id)}">
      <img src="/api/assets/${encodeURIComponent(asset.asset_id)}/file" alt="">
      <p><strong>${escapeHtml(asset.workflow_name || "workflow未設定")}</strong></p>
      <p>${escapeHtml(`seed ${params.seed || "-"} / ${asset.created_at || "-"}`)}</p>
      <label class="field"><span>状態</span><select data-compare-field="status">
        ${["draft", "candidate", "approved", "rejected", "archived"].map((status) => `<option value="${status}" ${asset.status === status ? "selected" : ""}>${status}</option>`).join("")}
      </select></label>
      <label class="field"><span>評価</span><input data-compare-field="rating" type="number" min="0" max="5" value="${escapeHtml(asset.rating || 0)}"></label>
      <label class="field"><span>タグ</span><input data-compare-field="tags" value="${escapeHtml((asset.tags || []).join(" "))}"></label>
      <label class="field"><span>短いコメント</span><textarea data-compare-field="comparison_note" rows="2">${escapeHtml(asset.comparison_note || "")}</textarea></label>
      <div class="action-row">
        <button type="button" data-compare-save="${escapeHtml(asset.asset_id)}">保存</button>
        <button type="button" data-open-asset="${escapeHtml(asset.asset_id)}">詳細</button>
        <button type="button" data-regenerate="${escapeHtml(asset.source_job_id || "")}">再生成</button>
        <button type="button" data-recipe-from-asset="${escapeHtml(asset.asset_id)}">レシピ</button>
      </div>
    </article>
  `;
}

async function saveCompareAsset(assetId) {
  const card = $(`[data-compare-asset="${CSS.escape(assetId)}"]`);
  if (!card) return;
  await api(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: card.querySelector('[data-compare-field="status"]').value,
      rating: Number(card.querySelector('[data-compare-field="rating"]').value || 0),
      tags: card.querySelector('[data-compare-field="tags"]').value,
      comparison_note: card.querySelector('[data-compare-field="comparison_note"]').value,
    }),
  });
  await searchAssets();
}

async function saveComparisonSet() {
  const path = activeComparisonId ? `/api/comparisons/${encodeURIComponent(activeComparisonId)}` : "/api/comparisons";
  const method = activeComparisonId ? "PATCH" : "POST";
  const result = await api(path, {
    method,
    body: JSON.stringify({
      asset_ids: [...selectedCompareAssets],
      name: $("#compareName").value,
      memo: $("#compareMemo").value,
      selection_result: $("#compareResult").value,
      improvement_note: $("#compareImprove").value,
    }),
  });
  activeComparisonId = result.comparison.comparison_id;
  await load();
  alert(`比較セットを保存しました: ${result.comparison.comparison_id}`);
}

function closeCompareView() {
  $("#compareView").classList.remove("open");
  $("#compareView").setAttribute("aria-hidden", "true");
  activeComparisonId = "";
}

function renderComparisons() {
  const list = $("#comparisonList");
  if (!list) return;
  const comparisons = (state.comparisons || []).filter((item) => item.status !== "archived");
  if (!comparisons.length) {
    list.innerHTML = `<div class="empty-state">保存済み比較セットはありません。</div>`;
    return;
  }
  list.innerHTML = comparisons.map((item) => `
    <article class="comparison-card" data-comparison-id="${escapeHtml(item.comparison_id)}">
      <header>
        <strong>${escapeHtml(item.name)}</strong>
        <span class="chip">${escapeHtml(`${item.asset_count || 0}枚 / 採用 ${item.approved_count || 0}`)}</span>
      </header>
      <p>${escapeHtml(item.memo || item.improvement_note || "-")}</p>
      <div class="action-row">
        <button type="button" data-open-comparison="${escapeHtml(item.comparison_id)}">開く</button>
        <button type="button" data-rename-comparison="${escapeHtml(item.comparison_id)}">名前変更</button>
        <button type="button" data-duplicate-comparison="${escapeHtml(item.comparison_id)}">複製</button>
        <button type="button" data-archive-comparison="${escapeHtml(item.comparison_id)}">アーカイブ</button>
      </div>
    </article>
  `).join("");
}

async function openComparison(comparisonId) {
  const result = await api(`/api/comparisons/${encodeURIComponent(comparisonId)}`);
  const assets = result.assets || [];
  if (!assets.length) {
    alert("比較対象の画像が見つかりません。");
    return;
  }
  if (assets.length < 2 && !confirm("一部の画像が見つかりません。利用可能な画像だけ開きますか？")) return;
  activeComparisonId = comparisonId;
  selectedCompareAssets = new Set(assets.map((asset) => asset.asset_id));
  $("#compareName").value = result.comparison.name || "";
  $("#compareMemo").value = result.comparison.memo || "";
  $("#compareResult").value = result.comparison.selection_result || "";
  $("#compareImprove").value = result.comparison.improvement_note || "";
  $("#compareGrid").innerHTML = assets.map((asset) => compareCardHtml(asset)).join("");
  closeAssetDetail();
  $("#compareView").classList.add("open");
  $("#compareView").setAttribute("aria-hidden", "false");
  updateCompareCount();
}

async function renameComparison(comparisonId) {
  const item = (state.comparisons || []).find((comparison) => comparison.comparison_id === comparisonId);
  const name = prompt("比較セット名", item?.name || "");
  if (!name) return;
  await api(`/api/comparisons/${encodeURIComponent(comparisonId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  await load();
}

async function duplicateComparison(comparisonId) {
  await api(`/api/comparisons/${encodeURIComponent(comparisonId)}/duplicate`, { method: "POST", body: "{}" });
  await load();
}

async function archiveComparison(comparisonId) {
  await api(`/api/comparisons/${encodeURIComponent(comparisonId)}/archive`, { method: "POST", body: "{}" });
  await load();
}

async function toggleExportCandidate(assetId) {
  const asset = (boardAssets.length ? boardAssets : state.assets).find((item) => item.asset_id === assetId);
  await api(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_export_candidate: !asset?.is_export_candidate }),
  });
  await searchBoard();
}

async function saveBoardNote(assetId, note) {
  await api(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ board_note: note }),
  });
  await searchBoard();
}

function renderJobs() {
  const list = $("#jobList");
  if (!state.jobs.length) {
    list.innerHTML = `<div class="empty-state">まだ生成履歴がありません。</div>`;
    return;
  }
  list.innerHTML = state.jobs.map((job) => {
    const params = safeJson(job.parameters_json);
    const prompt = job.prompt ? job.prompt.slice(0, 120) : "(promptなし)";
    return `
      <article class="job-card">
        <header>
          <strong>${escapeHtml(job.status)}</strong>
          <span class="chip">${escapeHtml(job.created_at)}</span>
        </header>
        <p>${escapeHtml(prompt)}</p>
        <p>${escapeHtml(`${params.width || "-"}x${params.height || "-"} / seed ${params.seed || "-"}`)}</p>
        ${job.error_message ? `<p class="bad-text">${escapeHtml(job.error_message)}</p>` : ""}
        ${job.comfy_prompt_id ? `<p>${escapeHtml(`prompt_id ${job.comfy_prompt_id}`)}</p>` : ""}
        ${["submitted", "running"].includes(job.status) ? `<button type="button" data-poll="${escapeHtml(job.job_id)}">完了確認</button>` : ""}
        <button type="button" data-regenerate="${escapeHtml(job.job_id)}">同条件再生成</button>
      </article>
    `;
  }).join("");
}

function renderAssets() {
  const grid = $("#assetGrid");
  if (!grid) return;
  if (activeScopeTab === "adult_local" && !adultStorageConfigured()) {
    grid.innerHTML = `<div class="empty-state">Adult Local保存先が未設定です。<br><button class="secondary" type="button" data-view-jump="settings">保存先を設定</button></div>`;
    updateCompareCount();
    return;
  }
  if (!state.assets.length) {
    grid.innerHTML = `<div class="empty-state">まだ取り込み済み画像がありません。</div>`;
    return;
  }
  grid.innerHTML = state.assets.map((asset) => {
    const params = safeJson(asset.parameters_json);
    const prompt = asset.prompt ? asset.prompt.slice(0, 80) : "(promptなし)";
    const selected = selectedCompareAssets.has(asset.asset_id);
    const scope = asset.content_scope || asset.safety_zone || "sfw";
    return `
      <article class="asset-card ${selected ? "compare-selected" : ""} ${scope === "adult_local" ? "adult-thumb" : ""}" data-asset-id="${escapeHtml(asset.asset_id)}">
        <div class="asset-thumb-wrap">
          <input class="asset-select" type="checkbox" data-compare-select="${escapeHtml(asset.asset_id)}" ${selected ? "checked" : ""} title="比較に追加">
          <img src="/api/assets/${encodeURIComponent(asset.asset_id)}/thumbnail" alt="" data-open-asset="${escapeHtml(asset.asset_id)}">
        </div>
        <div>
          <strong><span class="scope-badge ${escapeHtml(scope)}">${escapeHtml(scope)}</span>${escapeHtml(asset.status)} / ${escapeHtml(asset.workflow_name || "workflow未設定")}</strong>
          <p>${escapeHtml(prompt)}</p>
          <p>${escapeHtml(`seed ${params.seed || "-"} / ${asset.created_at}`)}</p>
          ${asset.recipe_name ? `<p>${escapeHtml(`recipe ${asset.recipe_name}`)}</p>` : ""}
          <p>${escapeHtml((asset.tags || []).join(" "))}</p>
          <div class="action-row">
            <button type="button" data-status="${escapeHtml(asset.asset_id)}:approved">採用</button>
            <button type="button" data-status="${escapeHtml(asset.asset_id)}:rejected">不採用</button>
            <button type="button" data-open-asset="${escapeHtml(asset.asset_id)}">詳細</button>
          </div>
          <button type="button" data-regenerate="${escapeHtml(asset.source_job_id || "")}">同条件で再生成</button>
        </div>
      </article>
    `;
  }).join("");
  updateCompareCount();
}

function renderBoardFilters() {
  if (!$("#boardFilterTags")) return;
  const current = {
    tags: [...($("#boardFilterTags")?.selectedOptions || [])].map((option) => option.value),
    workflow: $("#boardFilterWorkflow").value,
    recipe: $("#boardFilterRecipe").value,
    scope: $("#boardFilterScope").value,
    rating: $("#boardFilterRating").value,
  };
  $("#boardFilterTags").innerHTML = `<option value="untagged">タグ未設定</option>` + (state.tags || [])
    .map((tag) => `<option value="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</option>`)
    .join("");
  $("#boardFilterWorkflow").innerHTML = `<option value="">すべて</option>` + state.workflows
    .map((workflow) => `<option value="${escapeHtml(workflow.workflow_id)}">${escapeHtml(workflow.name)}</option>`)
    .join("");
  $("#boardFilterRecipe").innerHTML = `<option value="">すべて</option>` + (state.recipes || [])
    .filter((recipe) => recipe.status !== "archived")
    .map((recipe) => `<option value="${escapeHtml(recipe.recipe_id)}">${escapeHtml(recipe.name)}</option>`)
    .join("");
  $("#boardFilterScope").innerHTML = [
    ["", "すべて"],
    ["sfw", "SFW"],
    ["sensitive", "Sensitive"],
    ["adult_local", "Adult Local"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#boardFilterRating").innerHTML = [
    ["", "すべて"],
    ["1", "1以上"],
    ["2", "2以上"],
    ["3", "3以上"],
    ["4", "4以上"],
    ["5", "5"],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  [...$("#boardFilterTags").options].forEach((option) => { option.selected = current.tags.includes(option.value); });
  $("#boardFilterWorkflow").value = current.workflow;
  $("#boardFilterRecipe").value = current.recipe;
  $("#boardFilterScope").value = current.scope;
  $("#boardFilterRating").value = current.rating;
}

async function searchBoard() {
  const params = new URLSearchParams();
  for (const [key, selector] of [
    ["workflow_id", "#boardFilterWorkflow"],
    ["recipe_id", "#boardFilterRecipe"],
    ["content_scope", "#boardFilterScope"],
    ["rating", "#boardFilterRating"],
  ]) {
    const value = $(selector)?.value;
    if (value) params.set(key, value);
  }
  const tags = [...($("#boardFilterTags")?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
  if (tags.length) params.set("tags", tags.join(","));
  const result = await api(`/api/board?${params.toString()}`);
  boardAssets = result.assets;
  boardLoaded = true;
  renderBoard();
}

function renderBoard() {
  const grid = $("#boardGrid");
  if (!grid) return;
  const assets = boardLoaded ? boardAssets : (state.assets || []).filter((asset) => asset.status === "approved");
  if (!assets.length) {
    grid.innerHTML = `<div class="empty-state">採用済み素材がありません。</div>`;
    return;
  }
  grid.innerHTML = assets.map((asset) => {
    const params = safeJson(asset.parameters_json);
    const prompt = asset.prompt ? asset.prompt.slice(0, 70) : "(promptなし)";
    return `
      <article class="asset-card" data-board-asset="${escapeHtml(asset.asset_id)}">
        <img src="/api/assets/${encodeURIComponent(asset.asset_id)}/thumbnail" alt="" data-open-asset="${escapeHtml(asset.asset_id)}">
        <div>
          <strong>${escapeHtml(asset.workflow_name || "workflow未設定")} / 評価 ${escapeHtml(asset.rating || 0)}</strong>
          <p>${escapeHtml(prompt)}</p>
          <p>${escapeHtml(`recipe ${asset.recipe_name || "-"} / ${asset.content_scope || "sfw"}`)}</p>
          <p>${escapeHtml((asset.tags || []).join(" "))}</p>
          <label class="field"><span>ボードメモ</span><textarea class="board-note" data-board-note="${escapeHtml(asset.asset_id)}">${escapeHtml(asset.board_note || "")}</textarea></label>
          <div class="action-row">
            <button type="button" data-open-asset="${escapeHtml(asset.asset_id)}">詳細</button>
            <button type="button" data-regenerate="${escapeHtml(asset.source_job_id || "")}">再生成</button>
            ${asset.recipe_id ? `<button type="button" data-edit-recipe="${escapeHtml(asset.recipe_id)}">レシピ</button>` : ""}
            <button type="button" data-export-candidate="${escapeHtml(asset.asset_id)}">${asset.is_export_candidate ? "候補済み" : "書き出し候補"}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderRecipes() {
  const list = $("#recipeList");
  if (!list) return;
  const recipes = state.recipes || [];
  if (!recipes.length) {
    list.innerHTML = `<div class="empty-state">まだ保存済みレシピがありません。</div>`;
    return;
  }
  list.innerHTML = recipes.map((recipe) => {
    const tags = (recipe.tags || []).join(" ");
    const thumb = recipe.source_asset_id ? `/api/assets/${encodeURIComponent(recipe.source_asset_id)}/thumbnail` : "";
    return `
      <article class="recipe-card" data-recipe-id="${escapeHtml(recipe.recipe_id)}">
        ${thumb ? `<img src="${thumb}" alt="">` : `<div></div>`}
        <div>
          <h3>${escapeHtml(recipe.name)}</h3>
          <p>${escapeHtml(recipe.workflow_name || "workflow未設定")} / ${escapeHtml(recipe.updated_at)}</p>
          <p>${escapeHtml(tags)}</p>
          <p>${escapeHtml(`使用 ${recipe.use_count || 0} 回 / ${recipe.status}`)}</p>
        </div>
        <div class="recipe-actions">
          <button type="button" data-edit-recipe="${escapeHtml(recipe.recipe_id)}">詳細</button>
          <button type="button" data-use-recipe="${escapeHtml(recipe.recipe_id)}">呼び出す</button>
          <button type="button" data-duplicate-recipe="${escapeHtml(recipe.recipe_id)}">複製</button>
          <button type="button" data-archive-recipe="${escapeHtml(recipe.recipe_id)}">アーカイブ</button>
        </div>
      </article>
    `;
  }).join("");
}

function selectedRegisteredWorkflowId() {
  const value = $("#workflowSelect").value;
  return value && !value.startsWith("discover:") ? value : "";
}

function mappingForWorkflow(workflowId) {
  return state.mappings.filter((mapping) => mapping.workflow_id === workflowId);
}

function renderMappingTable() {
  const table = $("#mappingTable");
  const status = $("#mappingStatus");
  if (!table || !status) return;
  const workflowId = selectedRegisteredWorkflowId();
  if (!workflowId) {
    table.innerHTML = "";
    status.textContent = "登録済みWorkflowを選択してください。未登録Workflowは生成時に自動登録されます。";
    return;
  }
  const saved = mappingForWorkflow(workflowId);
  const savedByField = Object.fromEntries(saved.map((mapping) => [mapping.field_key, mapping]));
  activeMapping = Object.fromEntries(saved.map((mapping) => [mapping.field_key, `${mapping.node_id}::${mapping.input_key}`]));
  const candidates = mappingCandidates?.workflow_id === workflowId ? mappingCandidates.candidates : {};
  table.innerHTML = Object.entries(FIELD_LABELS).map(([fieldKey, label]) => {
    const options = candidates[fieldKey] || [];
    const savedOption = activeMapping[fieldKey] || "";
    const candidateOptions = options.map((item) => {
        const value = `${item.node_id}::${item.input_key}`;
        const text = `${item.node_id} ${item.title} / ${item.input_key}`;
        return `<option value="${escapeHtml(value)}" data-input-type="${escapeHtml(item.input_type)}" ${value === savedOption ? "selected" : ""}>${escapeHtml(text)}</option>`;
      });
    const hasSavedCandidate = options.some((item) => `${item.node_id}::${item.input_key}` === savedOption);
    const savedMapping = savedByField[fieldKey];
    const savedHtml = savedOption && !hasSavedCandidate
      ? `<option value="${escapeHtml(savedOption)}" data-input-type="${escapeHtml(savedMapping.input_type || "text")}" selected>保存済み: ${escapeHtml(savedMapping.node_id)} / ${escapeHtml(savedMapping.input_key)}</option>`
      : "";
    const optionHtml = [`<option value="">未設定</option>`, savedHtml, ...candidateOptions].join("");
    return `
      <div class="mapping-row">
        <label for="map-${escapeHtml(fieldKey)}">${escapeHtml(label)}</label>
        <select id="map-${escapeHtml(fieldKey)}" data-field-key="${escapeHtml(fieldKey)}">${optionHtml}</select>
      </div>
    `;
  }).join("");
  const savedFields = saved.map((mapping) => FIELD_LABELS[mapping.field_key] || mapping.field_key);
  status.textContent = savedFields.length ? `保存済み: ${savedFields.join(" / ")}` : "保存済みマッピングはありません。";
}

function selectedWorkflowRecord() {
  const workflowId = selectedRegisteredWorkflowId();
  if (!workflowId) return null;
  return (state.workflows || []).find((workflow) => workflow.workflow_id === workflowId) || null;
}

function selectedWorkflowAssetRequirements() {
  const workflow = selectedWorkflowRecord();
  if (!workflow) return [];
  return (assetRegistry.requirements || []).filter((item) => item.workflow_path === workflow.relative_path);
}

function renderAssetLinkPreview() {
  const panel = $("#assetLinkPreview");
  if (!panel) return;
  const selected = $("#workflowSelect")?.value || "";
  if (!selected) {
    panel.innerHTML = `<div class="empty-state">Workflowなし。資産リンク反映はありません。</div>`;
    return;
  }
  if (selected.startsWith("discover:")) {
    panel.innerHTML = `<div class="empty-state">未登録Workflowです。生成時に登録後、資産チェックで紐付けを確認できます。</div>`;
    return;
  }
  const requirements = selectedWorkflowAssetRequirements();
  const matched = requirements.filter((item) => item.status === "matched" && item.matched_item_id);
  const missing = requirements.filter((item) => item.status === "missing");
  panel.innerHTML = `
    <article class="asset-link-preview-card">
      <header>
        <strong>送信前の資産リンク</strong>
        <span class="chip ${missing.length ? "warn" : "ok"}">反映 ${matched.length} / 不足 ${missing.length}</span>
      </header>
      ${requirements.length ? `
        <div class="chip-list">
          ${matched.slice(0, 8).map((item) => `<span class="chip ok">${escapeHtml(assetKindLabel(item.asset_kind))}: ${escapeHtml(item.matched_relative_path || item.asset_name)}</span>`).join("")}
          ${missing.slice(0, 6).map((item) => `<span class="chip warn">${escapeHtml(assetKindLabel(item.asset_kind))}: ${escapeHtml(item.asset_name)}</span>`).join("")}
        </div>
        <p class="note">matched資産はWorkflow原本ではなく、ComfyUI送信用コピーにだけ反映されます。</p>
      ` : `<p class="note">このWorkflowの必要資産は未検出です。モデル画面の不足検知を実行してください。</p>`}
    </article>
  `;
}

function renderModels() {
  const list = $("#modelList");
  const models = state.connections.ollama.models || [];
  if (!models.length) {
    list.innerHTML = `<div class="empty-state">Ollamaモデル一覧を取得できませんでした。</div>`;
  } else {
    list.innerHTML = models.map((model) => `<span class="chip ok">${escapeHtml(model)}</span>`).join("");
  }
  renderAssetRegistry();
  renderWorkflowRequirements();
  renderCivitaiConfig();
}

function assetKindLabel(kind) {
  return {
    checkpoint: "Checkpoint",
    lora: "LoRA",
    vae: "VAE",
    controlnet: "ControlNet",
    upscaler: "Upscaler",
    workflow: "Workflow",
  }[kind] || kind;
}

function normalizeAssetName(value) {
  return String(value || "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|pth|pt|bin|onnx|json)$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function assetKindFromCivitaiType(value) {
  const type = String(value || "").toLowerCase();
  if (type.includes("lora")) return "lora";
  if (type.includes("vae")) return "vae";
  if (type.includes("controlnet")) return "controlnet";
  if (type.includes("upscaler")) return "upscaler";
  return "checkpoint";
}

function civitaiHashSet(files) {
  const hashes = new Set();
  (files || []).forEach((file) => {
    Object.values(file.hashes || {}).forEach((value) => {
      if (value) hashes.add(String(value).toLowerCase());
    });
  });
  return hashes;
}

function scoreCivitaiAssetCandidate(asset, item, kindHint) {
  if (!asset || asset.missing) return null;
  const model = item.model || {};
  const version = item.version || {};
  const files = version.files || [];
  const hashes = civitaiHashSet(files);
  let score = 0;
  const reasons = [];
  if (asset.asset_kind === kindHint) {
    score += 30;
    reasons.push("type");
  }
  if (asset.sha256 && hashes.has(String(asset.sha256).toLowerCase())) {
    score += 120;
    reasons.push("hash");
  }
  if (asset.source_url && item.source_url && asset.source_url === item.source_url) {
    score += 90;
    reasons.push("source");
  }
  const assetNames = [asset.file_name, asset.name, asset.relative_path].map(normalizeAssetName).filter(Boolean);
  const civitaiNames = [
    model.name,
    version.name,
    ...files.map((file) => file.name),
  ].map(normalizeAssetName).filter(Boolean);
  if (assetNames.some((assetName) => civitaiNames.some((name) => name && assetName === name))) {
    score += 60;
    reasons.push("filename");
  } else if (assetNames.some((assetName) => civitaiNames.some((name) => name && (assetName.includes(name) || name.includes(assetName))))) {
    score += 25;
    reasons.push("name");
  }
  if (!score && asset.asset_kind !== kindHint) return null;
  return { asset, score, reasons };
}

function civitaiAssetCandidates(item) {
  const kindHint = assetKindFromCivitaiType(item.model?.type);
  const scored = (assetRegistry.items || [])
    .map((asset) => scoreCivitaiAssetCandidate(asset, item, kindHint))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || String(a.asset.name).localeCompare(String(b.asset.name)));
  return {
    kindHint,
    candidates: scored.length
      ? scored
      : (assetRegistry.items || [])
        .filter((asset) => !asset.missing && asset.asset_kind === kindHint)
        .map((asset) => ({ asset, score: 0, reasons: ["type"] })),
  };
}

function renderAssetRegistry() {
  const summary = $("#assetRegistrySummary");
  const list = $("#assetRegistryList");
  if (!summary || !list) return;
  const locations = assetRegistry.locations || [];
  const items = assetRegistry.items || [];
  const counts = items.reduce((acc, item) => {
    const key = item.asset_kind || "unknown";
    acc[key] = (acc[key] || 0) + (item.missing ? 0 : 1);
    return acc;
  }, {});
  summary.innerHTML = `
    <div class="chip-list">
      ${Object.entries(counts).map(([kind, count]) => `<span class="chip ok">${escapeHtml(assetKindLabel(kind))}: ${escapeHtml(count)}</span>`).join("") || `<span class="chip warn">未スキャン</span>`}
      <span class="chip">保存先 ${locations.length}</span>
      <span class="chip">最終スキャン ${escapeHtml((assetRegistry.scan_runs || [])[0]?.finished_at || "-")}</span>
    </div>
  `;
  const locationHtml = locations.map((location) => `
    <article class="asset-registry-card ${location.path_exists ? "" : "missing"}">
      <header>
        <strong>${escapeHtml(location.name)}</strong>
        <span class="chip ${location.path_exists ? "ok" : "warn"}">${escapeHtml(assetKindLabel(location.asset_kind))}</span>
      </header>
      <p>${escapeHtml(location.base_path)}</p>
      <p>${escapeHtml(location.path_exists ? "path ok" : "path missing")} / ${location.is_external ? "external" : "studio"} / scan ${escapeHtml(location.last_scanned_at || "-")}</p>
    </article>
  `).join("");
  const itemHtml = items.slice(0, 80).map((item) => `
    <article class="asset-registry-card ${item.missing ? "missing" : ""} ${item.item_id === lastDownloadedAssetId ? "recent" : ""}">
      <header>
        <strong>${escapeHtml(item.name)}</strong>
        <span class="chip ${item.missing ? "warn" : "ok"}">${escapeHtml(assetKindLabel(item.asset_kind))}</span>
      </header>
      <p>${escapeHtml(item.relative_path)}</p>
      <p>${escapeHtml(item.location_name || "-")} / ${formatBytes(item.size_bytes || 0)} / ${escapeHtml(item.status || "unverified")}</p>
      <p>${escapeHtml([item.base_model, item.license, item.creator].filter(Boolean).join(" / ") || "metadata未設定")}</p>
      <div class="action-row">
        <button type="button" data-edit-registry-item="${escapeHtml(item.item_id)}">詳細編集</button>
      </div>
    </article>
  `).join("");
  list.innerHTML = `
    <details open>
      <summary>保存先 ${locations.length}件</summary>
      <div class="asset-registry-grid">${locationHtml || `<div class="empty-state">保存先がありません。</div>`}</div>
    </details>
    <details open>
      <summary>登録資産 ${items.length}件</summary>
      <div class="asset-registry-grid">${itemHtml || `<div class="empty-state">まだスキャンされていません。</div>`}</div>
    </details>
  `;
}

function renderWorkflowRequirements() {
  const summary = $("#workflowRequirementSummary");
  const list = $("#workflowRequirementList");
  if (!summary || !list) return;
  const requirements = assetRegistry.requirements || [];
  const counts = requirements.reduce((acc, item) => {
    const key = `${item.status}:${item.asset_kind}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  summary.innerHTML = `
    <div class="chip-list">
      ${Object.entries(counts).map(([key, count]) => {
        const [status, kind] = key.split(":");
        return `<span class="chip ${status === "missing" ? "warn" : "ok"}">${escapeHtml(status)} ${escapeHtml(assetKindLabel(kind))}: ${escapeHtml(count)}</span>`;
      }).join("") || `<span class="chip warn">未検出</span>`}
      <span class="chip">要求 ${requirements.length}</span>
    </div>
  `;
  list.innerHTML = `
    <div class="asset-registry-grid">
      ${requirements.map((item) => `
        <article class="asset-registry-card ${item.status === "missing" ? "missing" : ""}">
          <header>
            <strong>${escapeHtml(item.asset_name)}</strong>
            <span class="chip ${item.status === "missing" ? "warn" : "ok"}">${escapeHtml(item.status)}</span>
          </header>
          <p>${escapeHtml(item.workflow_name)} / node ${escapeHtml(item.node_id)} / ${escapeHtml(item.class_type)}</p>
          <p>${escapeHtml(assetKindLabel(item.asset_kind))} / ${escapeHtml(item.input_key)}</p>
          <p>${escapeHtml(item.matched_relative_path || "台帳一致なし")}</p>
          ${item.matched_item_id ? `<p><span class="chip ok">再スキャン時も保持</span></p>` : ""}
          ${renderWorkflowRequirementPicker(item)}
        </article>
      `).join("") || `<div class="empty-state">まだWorkflow要求資産を検出していません。</div>`}
    </div>
  `;
}

function renderWorkflowRequirementPicker(requirement) {
  const candidates = (assetRegistry.items || [])
    .filter((item) => !item.missing && item.asset_kind === requirement.asset_kind)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  if (!candidates.length) {
    return `<p class="note">同種の登録資産がありません。Civitai取得または保存先スキャンを行ってください。</p>`;
  }
  const selectId = `workflowAssetSelect-${requirement.requirement_id}`;
  return `
    <label class="field compact-field">
      <span>台帳資産を選択</span>
      <select id="${escapeHtml(selectId)}">
        ${candidates.map((asset) => `
          <option value="${escapeHtml(asset.item_id)}" ${asset.item_id === requirement.matched_item_id ? "selected" : ""}>
            ${escapeHtml(`${asset.name} / ${asset.relative_path}`)}
          </option>
        `).join("")}
      </select>
    </label>
    <div class="action-row">
      <button type="button" data-link-workflow-asset="${escapeHtml(requirement.requirement_id)}">この資産を使う</button>
      ${requirement.matched_item_id ? `<button class="secondary" type="button" data-clear-workflow-asset="${escapeHtml(requirement.requirement_id)}">解除</button>` : ""}
    </div>
  `;
}

async function scanWorkflowRequirements() {
  $("#scanWorkflowRequirements").disabled = true;
  try {
    const result = await api("/api/asset-registry/workflow-requirements/scan", { method: "POST", body: "{}" });
    assetRegistry.requirements = result.requirements || [];
    assetRegistry.requirement_counts = result.counts || [];
    renderWorkflowRequirements();
    renderAssetLinkPreview();
    return result;
  } finally {
    $("#scanWorkflowRequirements").disabled = false;
  }
}

async function linkWorkflowRequirementAsset(requirementId) {
  const select = $(`#workflowAssetSelect-${CSS.escape(requirementId)}`);
  const itemId = select?.value;
  if (!itemId) {
    alert("紐付ける資産を選択してください。");
    return;
  }
  const result = await api(`/api/asset-registry/workflow-requirements/${encodeURIComponent(requirementId)}`, {
    method: "PATCH",
    body: JSON.stringify({ item_id: itemId }),
  });
  assetRegistry.requirements = result.requirements || [];
  assetRegistry.requirement_counts = result.counts || [];
  renderWorkflowRequirements();
  renderAssetLinkPreview();
}

async function clearWorkflowRequirementAsset(requirementId) {
  const result = await api(`/api/asset-registry/workflow-requirements/${encodeURIComponent(requirementId)}`, {
    method: "PATCH",
    body: JSON.stringify({ clear: true }),
  });
  assetRegistry.requirements = result.requirements || [];
  assetRegistry.requirement_counts = result.counts || [];
  renderWorkflowRequirements();
  renderAssetLinkPreview();
}

async function refreshAssetRegistry() {
  assetRegistry = await api("/api/asset-registry");
  renderAssetRegistry();
  renderWorkflowRequirements();
  renderAssetLinkPreview();
}

function openAssetRegistryItem(itemId) {
  const item = (assetRegistry.items || []).find((entry) => entry.item_id === itemId);
  if (!item) return;
  activeAssetRegistryItem = item;
  $("#assetRegistryItemId").value = item.item_id;
  $("#assetRegistryItemStatus").value = item.status || "unverified";
  $("#assetRegistryItemBaseModel").value = item.base_model || "";
  $("#assetRegistryItemCreator").value = item.creator || "";
  $("#assetRegistryItemLicense").value = item.license || "";
  $("#assetRegistryItemSourceUrl").value = item.source_url || "";
  $("#assetRegistryItemNotes").value = item.notes || "";
  $("#assetRegistryItemInfo").innerHTML = `
    <dt>名前</dt><dd>${escapeHtml(item.name)}</dd>
    <dt>種類</dt><dd>${escapeHtml(assetKindLabel(item.asset_kind))}</dd>
    <dt>保存先</dt><dd>${escapeHtml(item.location_name || "-")}</dd>
    <dt>相対パス</dt><dd>${escapeHtml(item.relative_path)}</dd>
    <dt>サイズ</dt><dd>${escapeHtml(formatBytes(item.size_bytes || 0))}</dd>
  `;
  $("#assetRegistryItemDialog").showModal();
}

async function saveAssetRegistryItem(event) {
  event.preventDefault();
  const itemId = $("#assetRegistryItemId").value;
  if (!itemId) return;
  const result = await api(`/api/asset-registry/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: $("#assetRegistryItemStatus").value,
      base_model: $("#assetRegistryItemBaseModel").value,
      creator: $("#assetRegistryItemCreator").value,
      license: $("#assetRegistryItemLicense").value,
      source_url: $("#assetRegistryItemSourceUrl").value,
      notes: $("#assetRegistryItemNotes").value,
    }),
  });
  assetRegistry.items = (assetRegistry.items || []).map((item) => item.item_id === itemId ? result.item : item);
  renderAssetRegistry();
  $("#assetRegistryItemDialog").close();
  activeAssetRegistryItem = null;
}

async function scanAssetRegistry() {
  $("#scanAssetRegistry").disabled = true;
  try {
    assetRegistry = await api("/api/asset-registry/scan", { method: "POST", body: "{}" });
    renderAssetRegistry();
  } finally {
    $("#scanAssetRegistry").disabled = false;
  }
}

async function saveAssetLocation(event) {
  event.preventDefault();
  const name = $("#assetLocationName").value.trim();
  const basePath = $("#assetLocationPath").value.trim();
  if (!name || !basePath) {
    alert("保存先の名前とパスを入力してください。");
    return;
  }
  assetRegistry = await api("/api/asset-registry/locations", {
    method: "POST",
    body: JSON.stringify({
      name,
      asset_kind: $("#assetLocationKind").value,
      base_path: basePath,
      is_external: !basePath.startsWith("models/") && !basePath.startsWith("workflows/"),
      is_enabled: true,
    }),
  });
  $("#assetLocationName").value = "";
  $("#assetLocationPath").value = "";
  renderAssetRegistry();
}

async function loadCivitaiConfig() {
  civitaiConfig = await api("/api/civitai/config");
}

function renderCivitaiConfig() {
  const status = $("#civitaiKeyStatus");
  if (!status) return;
  const info = civitaiConfig?.civitai;
  if (!info) {
    status.textContent = "Civitai API Key状態を取得できませんでした。";
    return;
  }
  const sourceLabels = { environment: "環境変数", local_config: "ローカル設定", none: "未設定" };
  status.textContent = info.has_token
    ? `設定済み (${sourceLabels[info.source] || info.source})。キー本体は表示しません。`
    : "未設定。公開メタデータ確認は可能ですが、制限付きモデルではAPI Keyが必要になる場合があります。";
}

async function saveCivitaiKey(event) {
  event.preventDefault();
  const apiKey = $("#civitaiApiKey").value.trim();
  if (!apiKey) {
    alert("Civitai API Keyを入力してください。");
    return;
  }
  civitaiConfig = await api("/api/civitai/config", { method: "POST", body: JSON.stringify({ api_token: apiKey }) });
  $("#civitaiApiKey").value = "";
  renderCivitaiConfig();
  alert("Civitai API Keyをローカル設定に保存しました。");
}

async function deleteCivitaiKey() {
  const confirmed = confirm("ローカル保存したCivitai API Keyを削除します。環境変数で設定されたキーは削除されません。");
  if (!confirmed) return;
  civitaiConfig = await api("/api/civitai/config", { method: "DELETE" });
  renderCivitaiConfig();
  alert("Civitai API Key設定を削除しました。");
}

async function testCivitaiKey() {
  const result = await api("/api/civitai/lookup", { method: "POST", body: JSON.stringify({ url: "https://civitai.com/models/257749" }) });
  const modelName = result.civitai?.model?.name || "metadata";
  alert(`Civitai接続OK: ${modelName}`);
}

async function lookupCivitai(event) {
  event.preventDefault();
  const preview = $("#civitaiPreview");
  const url = $("#civitaiUrl").value.trim();
  if (!url) {
    preview.innerHTML = `<div class="empty-state">Civitai URLを入力してください。</div>`;
    return;
  }
  preview.innerHTML = `<div class="empty-state">Civitaiメタデータを取得しています...</div>`;
  const result = await api("/api/civitai/lookup", { method: "POST", body: JSON.stringify({ url }) });
  const item = result.civitai;
  lastCivitaiLookup = item;
  const model = item.model || {};
  const version = item.version || {};
  const files = version.files || [];
  const { kindHint, candidates } = civitaiAssetCandidates(item);
  const targetAssets = candidates.length
    ? candidates
    : (assetRegistry.items || []).filter((asset) => !asset.missing).map((asset) => ({ asset, score: 0, reasons: [] }));
  const targetOptions = targetAssets
    .map(({ asset, score, reasons }) => {
      const suffix = score ? ` / 候補 ${score} (${reasons.join(", ")})` : "";
      return `<option value="${escapeHtml(asset.item_id)}">${escapeHtml(`${assetKindLabel(asset.asset_kind)} / ${asset.name}${suffix}`)}</option>`;
    })
    .join("");
  const bestCandidate = targetAssets[0];
  preview.innerHTML = `
    <article class="civitai-card">
      <header>
        <strong>${escapeHtml(model.name || "名称未取得")}</strong>
        <span class="chip ${model.nsfw ? "warn" : "ok"}">${escapeHtml(model.type || "type不明")}</span>
      </header>
      <dl class="info-list">
        <dt>Creator</dt><dd>${escapeHtml(model.creator || "-")}</dd>
        <dt>Version</dt><dd>${escapeHtml(`${version.name || "-"} / ${version.base_model || "base不明"}`)}</dd>
        <dt>Trigger Words</dt><dd>${escapeHtml((version.trained_words || []).join(", ") || "-")}</dd>
        <dt>Tags</dt><dd>${escapeHtml((model.tags || []).slice(0, 16).join(", ") || "-")}</dd>
        <dt>Source</dt><dd><a href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer">Civitaiを開く</a></dd>
        <dt>Download</dt><dd><a href="${escapeHtml(version.download_url || "#")}" target="_blank" rel="noreferrer">download URLを開く</a></dd>
      </dl>
      <details>
        <summary>Files ${files.length}件</summary>
        <div class="file-list">
          ${files.map((file) => `
            <div>
              <strong>${escapeHtml(file.name || "file")}</strong>
              <span>${escapeHtml(`${file.type || "-"} / ${formatBytes((file.size_kb || 0) * 1024)} / pickle ${file.pickle_scan_result || "-"} / virus ${file.virus_scan_result || "-"}`)}</span>
            </div>
          `).join("") || `<p class="note">ファイル情報なし</p>`}
        </div>
      </details>
      <div class="civitai-apply">
        <button class="secondary" type="button" id="planCivitaiDownload">安全DL計画</button>
        <p class="note">保存先、上書き、scan結果、確認事項を事前確認します。実ファイルはまだダウンロードしません。</p>
        <div id="civitaiDownloadPlan" class="download-plan"></div>
      </div>
      <div class="civitai-apply">
        <div class="chip-list">
          <span class="chip">${escapeHtml(assetKindLabel(kindHint))}候補</span>
          <span class="chip ${bestCandidate ? "ok" : "warn"}">${bestCandidate ? `候補 ${targetAssets.length}件` : "反映先候補なし"}</span>
        </div>
        <label class="field">
          <span>反映先資産</span>
          <select id="civitaiAssetTarget">${targetOptions || `<option value="">資産台帳に反映先がありません</option>`}</select>
        </label>
        <button class="secondary" type="button" id="applyCivitaiToAsset">選択資産へ反映</button>
        <p class="note">反映先候補は種別、hash、ファイル名、既存source URLから推定します。出典URL、作者、base model、trigger words等を資産台帳へ反映します。ファイルは移動・ダウンロードしません。</p>
      </div>
    </article>
  `;
}

async function planCivitaiDownload() {
  if (!lastCivitaiLookup) {
    alert("先にCivitaiメタデータを確認してください。");
    return;
  }
  const planPanel = $("#civitaiDownloadPlan");
  planPanel.innerHTML = `<div class="empty-state">安全DL計画を作成しています...</div>`;
  const result = await api("/api/civitai/download-plan", {
    method: "POST",
    body: JSON.stringify({ civitai: lastCivitaiLookup }),
  });
  const readyLocations = (result.locations || []).filter((item) => item.path_exists && item.writable && !item.target_path_exists);
  planPanel.innerHTML = `
    <article class="storage-card">
      <header>
        <strong>${escapeHtml(result.file?.name || "file")}</strong>
        <span class="chip ${result.blockers?.length ? "warn" : "ok"}">${escapeHtml(assetKindLabel(result.asset_kind))}</span>
      </header>
      <p>${escapeHtml(formatBytes(result.file?.size_bytes || 0))} / pickle ${escapeHtml(result.file?.pickle_scan_result || "-")} / virus ${escapeHtml(result.file?.virus_scan_result || "-")}</p>
      <p>${escapeHtml(result.download_enabled ? "保存先を選び、DOWNLOAD と入力すると実ダウンロードできます。" : "ダウンロード前にblockerまたは保存先を確認してください。")}</p>
      <div class="chip-list">
        <span class="chip ${readyLocations.length ? "ok" : "warn"}">保存候補 ${readyLocations.length}</span>
        <span class="chip ${result.blockers?.length ? "warn" : "ok"}">blockers ${(result.blockers || []).length}</span>
        <span class="chip ${result.warnings?.length ? "warn" : "ok"}">warnings ${(result.warnings || []).length}</span>
      </div>
      ${readyLocations.length ? `
        <label class="field">
          <span>保存先</span>
          <select id="civitaiDownloadLocation">
            ${readyLocations.map((location) => `
              <option value="${escapeHtml(location.location_id)}" ${location.location_id === result.recommended_location_id ? "selected" : ""}>
                ${escapeHtml(`${location.name} / ${location.base_path}`)}
              </option>
            `).join("")}
          </select>
        </label>
        <label class="field">
          <span>最終確認</span>
          <input id="civitaiDownloadConfirmText" type="text" placeholder="DOWNLOAD" autocomplete="off">
        </label>
        <button class="primary" type="button" id="downloadCivitaiAsset" ${result.download_enabled ? "" : "disabled"}>確認してダウンロード</button>
        <button class="secondary" type="button" id="cancelCivitaiDownload" disabled>キャンセル</button>
        <div id="civitaiDownloadProgress" class="download-progress"></div>
        <p class="note">既存ファイルは上書きしません。CivitaiのSHA256がある場合は検証し、成功後に資産台帳へneeds_reviewで登録します。</p>
      ` : ""}
      ${(result.locations || []).length ? `
        <details open>
          <summary>保存先候補</summary>
          <div class="file-list">
            ${(result.locations || []).map((location) => `
              <div>
                <strong>${escapeHtml(location.name)}</strong>
                <span>${escapeHtml(`${location.base_path} / ${location.path_exists && location.writable ? "ready" : "not ready"} / ${location.target_path_exists ? "exists" : "new"}`)}</span>
              </div>
            `).join("")}
          </div>
        </details>
      ` : ""}
      ${(result.blockers || []).length ? `<div class="warning-text"><strong>Blockers</strong><ul>${result.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${(result.warnings || []).length ? `<div class="warning-text"><strong>Warnings</strong><ul>${result.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      <details>
        <summary>確認事項</summary>
        <ul>${(result.required_confirmations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </details>
    </article>
  `;
}

async function downloadCivitaiAsset() {
  if (!lastCivitaiLookup) {
    alert("先にCivitaiメタデータを確認してください。");
    return;
  }
  const locationId = $("#civitaiDownloadLocation")?.value;
  const confirmText = $("#civitaiDownloadConfirmText")?.value.trim();
  if (!locationId) {
    alert("保存先を選択してください。");
    return;
  }
  if (confirmText !== "DOWNLOAD") {
    alert("最終確認欄に DOWNLOAD と入力してください。");
    return;
  }
  const confirmed = confirm("Civitaiから選択ファイルをダウンロードし、成功後に資産台帳へneeds_reviewで登録します。既存ファイルは上書きしません。実行しますか？");
  if (!confirmed) return;
  const button = $("#downloadCivitaiAsset");
  const cancelButton = $("#cancelCivitaiDownload");
  const progressPanel = $("#civitaiDownloadProgress");
  if (button) {
    button.disabled = true;
    button.textContent = "開始中...";
  }
  if (cancelButton) cancelButton.disabled = false;
  if (progressPanel) progressPanel.innerHTML = `<span class="chip">queued</span>`;
  try {
    const started = await api("/api/civitai/download-jobs", {
      method: "POST",
      body: JSON.stringify({ civitai: lastCivitaiLookup, location_id: locationId, confirm_text: confirmText }),
    });
    activeCivitaiDownloadJobId = started.job?.job_id || "";
    if (!activeCivitaiDownloadJobId) throw new Error("download job was not created");
    if (button) button.textContent = "ダウンロード中...";
    const result = await pollCivitaiDownloadJob(activeCivitaiDownloadJobId);
    const item = result.item;
    if (item) {
      lastDownloadedAssetId = item.item_id;
      assetRegistry.items = [
        item,
        ...(assetRegistry.items || []).filter((existing) => existing.item_id !== item.item_id),
      ];
      renderAssetRegistry();
    }
    await refreshAssetRegistry();
    const requirementResult = await scanWorkflowRequirements();
    const matched = requirementResult?.scan_summary?.matched ?? 0;
    const missing = requirementResult?.scan_summary?.missing ?? 0;
    await planCivitaiDownload();
    const panel = $("#civitaiDownloadPlan");
    if (panel) {
      panel.insertAdjacentHTML("afterbegin", `
        <article class="storage-card">
          <header>
            <strong>登録完了</strong>
            <span class="chip ok">needs_review</span>
          </header>
          <p>${escapeHtml(result.file?.name || item?.file_name || "file")} を資産台帳へ登録しました。</p>
          <p>Workflow要求資産を再照合しました。matched ${escapeHtml(matched)} / missing ${escapeHtml(missing)}</p>
          <div class="action-row">
            <button type="button" data-edit-registry-item="${escapeHtml(item?.item_id || "")}">登録資産を確認</button>
          </div>
        </article>
      `);
    }
    if (item?.item_id) openAssetRegistryItem(item.item_id);
    alert(`ダウンロードして資産台帳へ登録しました: ${result.file?.name || item?.file_name || "file"}`);
  } finally {
    activeCivitaiDownloadJobId = "";
    if (button) {
      button.disabled = false;
      button.textContent = "確認してダウンロード";
    }
    if (cancelButton) cancelButton.disabled = true;
  }
}

function renderCivitaiDownloadProgress(job) {
  const progressPanel = $("#civitaiDownloadProgress");
  if (!progressPanel || !job) return;
  const downloaded = formatBytes(job.downloaded_bytes || 0);
  const total = job.total_bytes ? formatBytes(job.total_bytes) : "size不明";
  const percent = job.percent ? `${job.percent}%` : "計測中";
  progressPanel.innerHTML = `
    <div class="progress-row">
      <span class="chip ${job.status === "failed" ? "warn" : "ok"}">${escapeHtml(job.status || "running")}</span>
      <span>${escapeHtml(`${downloaded} / ${total} / ${percent}`)}</span>
    </div>
    <progress max="100" value="${escapeHtml(job.percent || 0)}"></progress>
    ${job.error ? `<p class="warning-text">${escapeHtml(job.error)}</p>` : ""}
  `;
}

async function pollCivitaiDownloadJob(jobId) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const payload = await api(`/api/civitai/download-jobs/${encodeURIComponent(jobId)}`);
    const job = payload.job;
    renderCivitaiDownloadProgress(job);
    if (job.status === "completed") return job.result;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error || `download ${job.status}`);
    }
  }
}

async function cancelCivitaiDownload() {
  if (!activeCivitaiDownloadJobId) return;
  await api(`/api/civitai/download-jobs/${encodeURIComponent(activeCivitaiDownloadJobId)}/cancel`, { method: "POST", body: "{}" });
  renderCivitaiDownloadProgress({ status: "cancelling", downloaded_bytes: 0, total_bytes: 0, percent: 0 });
}

async function applyCivitaiToAsset() {
  if (!lastCivitaiLookup) {
    alert("先にCivitaiメタデータを確認してください。");
    return;
  }
  const itemId = $("#civitaiAssetTarget")?.value;
  if (!itemId) {
    alert("反映先資産を選択してください。");
    return;
  }
  const result = await api("/api/asset-registry/apply-civitai", {
    method: "POST",
    body: JSON.stringify({ item_id: itemId, civitai: lastCivitaiLookup }),
  });
  assetRegistry.items = (assetRegistry.items || []).map((item) => item.item_id === itemId ? result.item : item);
  renderAssetRegistry();
  alert("Civitaiメタデータを資産台帳へ反映しました。確認状態はneeds_reviewです。");
}

function renderPromptTranslation() {
  const presetSelect = $("#translationPreset");
  if (!presetSelect) return;
  const presets = promptTranslation.presets || [];
  const current = presetSelect.value;
  presetSelect.innerHTML = presets
    .filter((preset) => preset.is_enabled)
    .map((preset) => `<option value="${escapeHtml(preset.preset_id)}">${escapeHtml(preset.name)}${preset.is_default ? " / 既定" : ""}</option>`)
    .join("");
  if ([...presetSelect.options].some((option) => option.value === current)) {
    presetSelect.value = current;
  }
  renderTranslationResult(promptTranslation.last);
}

function renderTranslationResult(result) {
  if (!$("#translatedPrompt")) return;
  $("#translatedPrompt").value = result?.translated_prompt || "";
  $("#translatedNegative").value = result?.translated_negative || "";
  const terms = result?.unconverted_terms || [];
  $("#translationUnconverted").innerHTML = terms.length
    ? terms.map((term) => `<span class="chip warn">${escapeHtml(term)}</span>`).join("")
    : `<span class="chip ok">なし</span>`;
}

async function refreshPromptTranslation() {
  const result = await api("/api/prompt-translation");
  promptTranslation = { ...promptTranslation, ...result, last: promptTranslation.last };
  renderPromptTranslation();
}

async function convertPromptTranslation() {
  const status = $("#translationStatus");
  status.textContent = "変換中...";
  const result = await api("/api/prompt-translation/convert", {
    method: "POST",
    body: JSON.stringify({
      source_prompt: $("#translationSourcePrompt").value,
      source_negative: $("#translationSourceNegative").value,
      preset_id: $("#translationPreset").value,
    }),
  });
  promptTranslation.last = result.result;
  renderTranslationResult(result.result);
  status.textContent = `変換しました。履歴ID: ${result.result.history_id}`;
  await refreshTranslationHistory(false).catch(() => null);
}

function applyPromptTranslation() {
  if (!promptTranslation.last) {
    alert("先にPromptを変換してください。");
    return;
  }
  const form = $("#generateForm");
  form.elements.prompt.value = promptTranslation.last.translated_prompt || "";
  form.elements.negative_prompt.value = promptTranslation.last.translated_negative || "";
  $("#translationStatus").textContent = "生成Promptへ反映しました。";
}

async function openTranslationTerms() {
  await refreshTranslationTerms(false);
  $("#translationTermsDialog").showModal();
}

function renderTranslationTerms() {
  const list = $("#translationTermList");
  if (!list) return;
  const query = ($("#translationTermSearch").value || "").toLowerCase();
  const terms = (promptTranslation.terms || []).filter((term) => {
    const haystack = `${term.source_text} ${term.target_text} ${term.category}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  list.innerHTML = terms.length ? terms.map((term) => `
    <article class="term-row ${term.is_enabled ? "" : "disabled"}">
      <div>
        <strong>${escapeHtml(term.source_text)} → ${escapeHtml(term.target_text)}</strong>
        <p>${escapeHtml(term.category || "general")} / weight ${escapeHtml(term.weight || 0)}</p>
      </div>
      <div class="term-actions">
        <button type="button" data-edit-translation-term="${escapeHtml(term.term_id)}">編集</button>
        <button type="button" data-toggle-translation-term="${escapeHtml(term.term_id)}:${term.is_enabled ? "0" : "1"}">${term.is_enabled ? "無効化" : "有効化"}</button>
      </div>
    </article>
  `).join("") : `<div class="empty-state">辞書語がありません。</div>`;
}

async function refreshTranslationTerms(renderOnly = true) {
  const result = await api("/api/prompt-translation/terms");
  promptTranslation.terms = result.terms || [];
  renderTranslationTerms();
  if (!renderOnly) renderPromptTranslation();
}

async function saveTranslationTerm(event) {
  event.preventDefault();
  await api("/api/prompt-translation/terms", {
    method: "POST",
    body: JSON.stringify({
      source_text: $("#newTranslationSource").value,
      target_text: $("#newTranslationTarget").value,
      category: $("#newTranslationCategory").value || "general",
      weight: Number($("#newTranslationWeight").value || 0),
      is_enabled: true,
    }),
  });
  $("#newTranslationSource").value = "";
  $("#newTranslationTarget").value = "";
  $("#newTranslationCategory").value = "";
  $("#newTranslationWeight").value = "0";
  await refreshTranslationTerms();
}

async function editTranslationTerm(termId) {
  const term = (promptTranslation.terms || []).find((item) => item.term_id === termId);
  if (!term) return;
  const targetText = prompt("英語タグ", term.target_text || "");
  if (targetText == null) return;
  const category = prompt("カテゴリ", term.category || "general");
  if (category == null) return;
  await api(`/api/prompt-translation/terms/${encodeURIComponent(termId)}`, {
    method: "PATCH",
    body: JSON.stringify({ target_text: targetText, category }),
  });
  await refreshTranslationTerms();
}

async function toggleTranslationTerm(termId, enabled) {
  await api(`/api/prompt-translation/terms/${encodeURIComponent(termId)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_enabled: enabled }),
  });
  await refreshTranslationTerms();
}

async function openTranslationHistory() {
  await refreshTranslationHistory();
  $("#translationHistoryDialog").showModal();
}

function normalizeHistoryItem(item) {
  if (Array.isArray(item.unconverted_terms)) return item;
  try {
    item.unconverted_terms = JSON.parse(item.unconverted_terms_json || "[]");
  } catch {
    item.unconverted_terms = [];
  }
  return item;
}

function renderTranslationHistory() {
  const list = $("#translationHistoryList");
  if (!list) return;
  const history = (promptTranslation.history || []).map(normalizeHistoryItem);
  list.innerHTML = history.length ? history.map((item) => `
    <article class="history-row">
      <div>
        <strong>${escapeHtml(item.created_at || "-")}</strong>
        <p>${escapeHtml(item.source_prompt || "-")}</p>
        <p>${escapeHtml(item.translated_prompt || "-")}</p>
        <p>${escapeHtml(`未変換: ${(item.unconverted_terms || []).join(", ") || "なし"}`)}</p>
      </div>
      <button type="button" data-reuse-translation-history="${escapeHtml(item.history_id)}">再利用</button>
    </article>
  `).join("") : `<div class="empty-state">変換履歴はまだありません。</div>`;
}

async function refreshTranslationHistory(renderPanel = true) {
  const result = await api("/api/prompt-translation/history");
  promptTranslation.history = result.history || [];
  renderTranslationHistory();
  if (renderPanel) renderPromptTranslation();
}

function reuseTranslationHistory(historyId) {
  const item = (promptTranslation.history || []).map(normalizeHistoryItem).find((history) => history.history_id === historyId);
  if (!item) return;
  promptTranslation.last = {
    history_id: item.history_id,
    source_prompt: item.source_prompt,
    translated_prompt: item.translated_prompt,
    source_negative: item.source_negative,
    translated_negative: item.translated_negative,
    unconverted_terms: item.unconverted_terms || [],
    preset_id: item.preset_id,
  };
  $("#translationSourcePrompt").value = item.source_prompt || "";
  $("#translationSourceNegative").value = item.source_negative || "";
  renderTranslationResult(promptTranslation.last);
  $("#translationHistoryDialog").close();
  $("#translationStatus").textContent = "履歴を再利用できます。必要なら生成Promptへ反映してください。";
}

function renderSettings() {
  const details = $("#connectionDetails");
  const { comfyui, ollama } = state.connections;
  const adultStorage = adultStorageStatus();
  details.innerHTML = `
    <dt>ComfyUI</dt><dd>${escapeHtml(comfyui.endpoint)} / ${escapeHtml(comfyui.detail)}</dd>
    <dt>Ollama</dt><dd>${escapeHtml(ollama.endpoint)} / ${escapeHtml(ollama.detail)}</dd>
    <dt>Git</dt><dd>${escapeHtml(state.git.output || "no output")}</dd>
    <dt>Adult Local保存先</dt><dd>${escapeHtml(adultStorage.label)}</dd>
  `;
  renderSetupStatus();
}

async function loadSetupStatus() {
  setupStatus = await api("/api/setup/status");
}

function setupActionLabel(action) {
  return {
    backup: "バックアップ作成",
    storage: "保存先を確認",
    models: "資産台帳へ",
    workflow_scan: "不足検知",
    settings: "設定を確認",
    launcher: "起動情報",
  }[action] || "確認";
}

function renderSetupWizard(setup) {
  const steps = setup.steps || [];
  const required = steps.filter((step) => step.required);
  const requiredOk = required.length && required.every((step) => step.status === "ok");
  const prefs = setup.preferences || {};
  const collapsed = prefs.dismissed || prefs.completed;
  return `
    <details class="setup-wizard" ${collapsed ? "" : "open"}>
      <summary>
        <span>初回セットアップ</span>
        <span class="chip ${requiredOk ? "ok" : "warn"}">${requiredOk ? "必須OK" : "要確認"}</span>
        ${prefs.completed ? `<span class="chip ok">完了済み</span>` : ""}
      </summary>
      <div class="setup-step-list">
        ${steps.map((step) => `
          <article class="setup-step ${escapeHtml(step.status)}">
            <header>
              <strong>${escapeHtml(step.label)}</strong>
              <span class="chip ${escapeHtml(step.status)}">${escapeHtml(step.status)}</span>
            </header>
            <p>${escapeHtml(step.detail || "-")}</p>
            <div class="action-row">
              <button class="secondary" type="button" data-setup-action="${escapeHtml(step.action || "")}">${escapeHtml(setupActionLabel(step.action))}</button>
            </div>
          </article>
        `).join("")}
      </div>
      <div class="action-row">
        <button type="button" data-setup-state="completed">セットアップ完了</button>
        <button class="secondary" type="button" data-setup-state="dismissed">後で表示しない</button>
        ${(prefs.completed || prefs.dismissed) ? `<button class="secondary" type="button" data-setup-state="reset">再表示</button>` : ""}
      </div>
    </details>
  `;
}

function renderSetupStatus() {
  const panel = $("#setupStatusPanel");
  if (!panel) return;
  const setup = setupStatus?.setup;
  if (!setup) {
    panel.innerHTML = `<div class="empty-state">セットアップ状態を取得できませんでした。</div>`;
    return;
  }
  const requirements = setup.asset_registry?.workflow_requirements || [];
  const missingCount = requirements
    .filter((item) => item.status === "missing")
    .reduce((total, item) => total + Number(item.count || 0), 0);
  const assetCounts = (setup.asset_registry?.items || [])
    .map((item) => `${assetKindLabel(item.asset_kind)} ${item.count}`)
    .join(" / ");
  panel.innerHTML = `
    ${renderSetupWizard(setup)}
    <div class="diagnostic-grid">
      ${diagnosticCard("起動", [
        `Launcher ${setup.launcher.exists ? "OK" : "未作成"}`,
        setup.launcher.url,
      ], setup.launcher.exists ? "ok" : "warn")}
      ${diagnosticCard("DBバックアップ", [
        formatBytes(setup.database.size_bytes),
        setup.database.backup_dir,
      ], setup.database.exists ? "ok" : "bad")}
      ${diagnosticCard("保存先", [
        `ready ${setup.storage.ready} / ${setup.storage.total}`,
        `issues ${(setup.storage.issues || []).length}`,
      ], (setup.storage.issues || []).length ? "warn" : "ok")}
      ${diagnosticCard("資産台帳", [
        assetCounts || "未スキャン",
        `Workflow不足 ${missingCount}`,
      ], missingCount ? "warn" : "ok")}
    </div>
    <div class="diagnostic-notes">
      <p>ローカル配布に向けた最小セットアップ状態です。DBバックアップは ` + "`studio/data/backups/`" + ` に作成され、Git公開対象には含まれません。</p>
      <div class="action-row">
        <button class="secondary" type="button" id="openDatabaseRestoreDialog">復元候補を確認</button>
      </div>
    </div>
  `;
}

async function createDatabaseBackup() {
  const result = await api("/api/database/backup", {
    method: "POST",
    body: JSON.stringify({ reason: "manual-ui" }),
  });
  await loadSetupStatus();
  renderSetupStatus();
  await load();
  alert(`DBバックアップを作成しました。\n${result.relative_path}\n${formatBytes(result.size_bytes)}`);
}

async function saveSetupWizardState(mode) {
  const payload = mode === "reset"
    ? { completed: false, dismissed: false }
    : { [mode]: true };
  setupStatus = await api("/api/setup/state", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  renderSetupStatus();
}

async function runSetupAction(action) {
  if (action === "backup") {
    await createDatabaseBackup();
    return;
  }
  if (action === "storage" || action === "settings" || action === "launcher") {
    switchView("settings");
    return;
  }
  if (action === "models") {
    switchView("models");
    return;
  }
  if (action === "workflow_scan") {
    switchView("models");
    await scanWorkflowRequirements();
    await loadSetupStatus();
    renderSetupStatus();
  }
}

async function openDatabaseRestoreDialog() {
  const result = await api("/api/database/backups");
  databaseBackups = result.backups || [];
  renderDatabaseBackups();
  $("#databaseRestoreConfirmText").value = "";
  $("#databaseRestoreResult").textContent = "";
  $("#databaseRestoreDialog").showModal();
}

function renderDatabaseBackups() {
  const list = $("#databaseBackupList");
  const select = $("#databaseRestoreBackup");
  if (!list || !select) return;
  select.innerHTML = databaseBackups
    .map((backup) => `<option value="${escapeHtml(backup.relative_path)}">${escapeHtml(`${backup.name} / ${formatBytes(backup.size_bytes)}`)}</option>`)
    .join("");
  list.innerHTML = databaseBackups.length
    ? databaseBackups.slice(0, 30).map((backup) => `
      <article class="storage-card">
        <header><strong>${escapeHtml(backup.name)}</strong><span class="chip ok">${escapeHtml(formatBytes(backup.size_bytes))}</span></header>
        <p>${escapeHtml(backup.relative_path)}</p>
        <p>${escapeHtml(backup.created_at || "-")}</p>
      </article>
    `).join("")
    : `<div class="empty-state">DBバックアップがありません。</div>`;
}

async function restoreDatabaseBackup(event) {
  event.preventDefault();
  const relativePath = $("#databaseRestoreBackup").value;
  const confirmText = $("#databaseRestoreConfirmText").value.trim();
  if (confirmText !== "RESTORE") {
    $("#databaseRestoreResult").textContent = "復元するには RESTORE と入力してください。";
    return;
  }
  const confirmed = confirm("DBを選択したバックアップで復元します。現在のDBは復元直前に自動バックアップされます。続行しますか？");
  if (!confirmed) return;
  const result = await api("/api/database/restore", {
    method: "POST",
    body: JSON.stringify({ relative_path: relativePath, confirm_text: confirmText }),
  });
  $("#databaseRestoreResult").textContent = `復元しました。退避バックアップ: ${result.pre_restore_backup?.relative_path || "-"}`;
  alert("DB復元が完了しました。画面を再読み込みします。");
  location.reload();
}

function renderDiagnostics() {
  const panel = $("#diagnosticsPanel");
  if (!panel) return;
  const diag = state.diagnostics;
  if (!diag) {
    panel.innerHTML = `<div class="empty-state">診断情報を取得できませんでした。</div>`;
    return;
  }
  const statusCounts = Object.fromEntries((diag.job_statuses || []).map((item) => [item.status, item.count]));
  const requiredIssues = [
    ...(diag.missing_mappings || []).map((item) => `${item.name}: ${item.missing.map((field) => FIELD_LABELS[field] || field).join(", ")}`),
    ...(diag.storage_issues || []).map((item) => `${item.name}: ${item.validation || "storage issue"}`),
    ...(diag.prompt_id_missing || []).map((item) => `${item.job_id}: prompt_idなし`),
  ];
  panel.innerHTML = `
    <div class="diagnostic-grid">
      ${diagnosticCard("接続", [
        `ComfyUI ${diag.connections.comfyui.ok ? "OK" : "NG"}`,
        `Ollama ${diag.connections.ollama.ok ? "OK" : "NG"}`,
        `Git ${diag.git.ok ? "OK" : "NG"}`,
      ], diag.connections.comfyui.ok && diag.connections.ollama.ok && diag.git.ok ? "ok" : "warn")}
      ${diagnosticCard("DB", [
        `${diag.counts.jobs} jobs`,
        `${diag.counts.assets} assets`,
        `${diag.counts.outputs} outputs`,
        `${formatBytes(diag.database.size_bytes)}`,
      ], diag.database.exists ? "ok" : "bad")}
      ${diagnosticCard("ジョブ", [
        `submitted ${statusCounts.submitted || 0}`,
        `running ${statusCounts.running || 0}`,
        `failed ${statusCounts.failed || 0}`,
        `再同期候補 ${(diag.resync_candidates || []).length}`,
      ], (diag.active_jobs || []).length ? "warn" : "ok")}
      ${diagnosticCard("保存先", [
        `Adult Local ${diag.adult_storage_ok ? "OK" : "要確認"}`,
        `要確認 ${(diag.storage_issues || []).length}`,
      ], diag.adult_storage_ok && !(diag.storage_issues || []).length ? "ok" : "warn")}
    </div>
    <div class="diagnostic-notes">
      <p>${escapeHtml(`最終診断 ${diag.generated_at || "-"}`)}</p>
      ${(diag.warnings || []).length
        ? `<ul>${diag.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : `<p class="good-text">主要状態に警告はありません。</p>`}
      ${requiredIssues.length
        ? `<details><summary>確認が必要な項目 ${requiredIssues.length}件</summary><ul>${requiredIssues.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
        : ""}
    </div>
  `;
}

function diagnosticCard(title, lines, level = "") {
  return `
    <article class="diagnostic-card ${escapeHtml(level)}">
      <header><strong>${escapeHtml(title)}</strong><span class="chip ${escapeHtml(level)}">${escapeHtml(level || "info")}</span></header>
      ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    </article>
  `;
}

async function resyncJobs() {
  const result = await api("/api/jobs/resync", { method: "POST", body: JSON.stringify({ include_completed: false, limit: 50 }) });
  await load();
  const completed = (result.results || []).filter((item) => item.status === "completed").length;
  const failed = (result.results || []).filter((item) => item.ok === false || item.status === "failed").length;
  alert(`再同期: 対象 ${result.requested}件 / completed ${completed}件 / failed ${failed}件`);
}

async function shutdownStudio() {
  const confirmed = confirm("AI Media Factory Studioを停止します。停止後はデスクトップの起動アイコンから再開してください。");
  if (!confirmed) return;
  await api("/api/shutdown", { method: "POST", body: "{}" });
  document.body.innerHTML = `
    <main class="shutdown-screen">
      <section class="surface">
        <h1>AI Media Factory Studioを停止しました</h1>
        <p>再開するときは、デスクトップの起動アイコンをダブルクリックしてください。</p>
      </section>
    </main>
  `;
}

function renderStorage() {
  const list = $("#storageList");
  if (!list) return;
  const storage = state.storage || [];
  const adult = storage.find((item) => item.content_scope === "adult_local" && item.is_enabled);
  const statusLabel = (item) => {
    if (!item.is_enabled) return "無効";
    if (!item.path_exists) return "未接続";
    if (!item.writable) return "書込不可";
    if (!item.is_comfy_output_compatible) return "出力ルート外";
    return "利用可能";
  };
  list.innerHTML = `
    <div class="storage-card">
      <header><strong>一般</strong><span class="chip ok">${storage.filter((item) => item.content_scope === "general").length}件</span></header>
      <p>${escapeHtml(storage.find((item) => item.content_scope === "general")?.base_path || "未設定")}</p>
    </div>
    <div class="storage-card">
      <header><strong>Adult Local</strong><span class="chip ${adultStorageConfigured() ? "ok" : "warn"}">${adult ? statusLabel(adult) : "未設定"}</span></header>
      <p>${escapeHtml(adult?.base_path || "未設定")}</p>
      ${adult ? "" : `<button class="secondary" type="button" data-add-storage-scope="adult_local">保存先を追加</button>`}
    </div>
    ${storage.map((item) => `
      <article class="storage-card" data-storage-id="${escapeHtml(item.storage_id)}">
        <header>
          <strong>${escapeHtml(item.name)}</strong>
          <span class="chip ${item.is_enabled ? "ok" : "warn"}">${escapeHtml(item.content_scope)} / ${escapeHtml(item.usage_type || "generated")}</span>
        </header>
        <p>${escapeHtml(item.base_path)}</p>
        <p>${escapeHtml(`状態 ${statusLabel(item)} / 書込 ${item.writable ? "可" : "不可"} / 空き ${formatBytes(item.free_space_bytes)}`)}</p>
        <p>${escapeHtml(`ComfyUI出力ルート ${item.is_comfy_output_compatible ? "内" : "外"} / 相対 ${item.comfy_output_relative_path || "-"}`)}</p>
        <p>${escapeHtml(`最終確認 ${item.last_checked_at || "-"} / 判定 ${item.last_validation_result || "-"}`)}</p>
        <div class="action-row">
          <button type="button" data-edit-storage="${escapeHtml(item.storage_id)}">編集</button>
          <button type="button" data-test-storage="${escapeHtml(item.storage_id)}">書き込みテスト</button>
          <button type="button" data-toggle-storage="${escapeHtml(item.storage_id)}:${item.is_enabled ? "0" : "1"}">${item.is_enabled ? "無効化" : "有効化"}</button>
        </div>
      </article>
    `).join("")}
  `;
}

function openStorageDialog(scope = "general", storageId = "") {
  const storage = storageId ? (state.storage || []).find((item) => item.storage_id === storageId) : null;
  $("#storageId").value = storage?.storage_id || "";
  $("#storageName").value = storage?.name || (scope === "adult_local" ? "Adult Local" : "Storage");
  $("#storageBasePath").value = storage?.base_path || "";
  $("#storageScope").value = storage?.content_scope || scope;
  $("#storageUsage").value = storage?.usage_type || "generated";
  $("#storageEnabled").value = String(storage?.is_enabled ?? 1);
  $("#storageDefault").checked = Boolean(storage?.is_default);
  $("#storageTestResult").textContent = "";
  $("#storageDialog").showModal();
}

function storagePayload() {
  return {
    name: $("#storageName").value,
    base_path: $("#storageBasePath").value,
    content_scope: $("#storageScope").value,
    usage_type: $("#storageUsage").value,
    is_enabled: $("#storageEnabled").value === "1",
    is_default: $("#storageDefault").checked,
  };
}

async function saveStorage(event) {
  event.preventDefault();
  const storageId = $("#storageId").value;
  const path = storageId ? `/api/storage/${encodeURIComponent(storageId)}` : "/api/storage";
  const method = storageId ? "PATCH" : "POST";
  await api(path, { method, body: JSON.stringify(storagePayload()) });
  $("#storageDialog").close();
  await load();
}

async function testStorage(storageId = "") {
  const payload = storageId ? { storage_id: storageId } : { base_path: $("#storageBasePath").value };
  const result = await api("/api/storage/test", { method: "POST", body: JSON.stringify(payload) });
  const text = result.ok ? `OK / 空き ${formatBytes(result.free_space_bytes)}` : `NG: ${result.error}`;
  if ($("#storageDialog").open) $("#storageTestResult").textContent = text;
  else alert(text);
  await load();
}

function formatBytes(value) {
  if (!value && value !== 0) return "-";
  const gb = Number(value) / 1024 / 1024 / 1024;
  return `${gb.toFixed(1)} GB`;
}

function updateScopeWarning() {
  const selectedMode = $("#generateForm")?.elements.mode?.value || "sfw";
  const status = adultStorageStatus();
  if ($("#scopeStatus")) {
    const labels = { sfw: "通常", sensitive: "Sensitive", adult_local: "Adult Local" };
    $("#scopeStatus").textContent = selectedMode === "adult_local"
      ? status.label
      : `Scope: ${labels[selectedMode] || selectedMode} / 出力prefixはComfyUI出力ルート配下に作成します。`;
    $("#scopeStatus").classList.toggle("warn", selectedMode === "adult_local" && !status.ok);
  }
  if ($("#adultLocalNotice")) $("#adultLocalNotice").hidden = selectedMode !== "adult_local";
  if ($("#scopeWarning")) $("#scopeWarning").hidden = !(selectedMode === "adult_local" && !status.ok);
}

async function submitGeneration(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const workflowId = await ensureWorkflowRegistered();
  const payload = Object.fromEntries(form.entries());
  payload.workflow_id = workflowId || null;
  payload.width = Number(payload.width);
  payload.height = Number(payload.height);
  payload.batch_size = Number(payload.batch_size);
  payload.steps = Number(payload.steps);
  payload.cfg = Number(payload.cfg);
  const result = await api("/api/generate", { method: "POST", body: JSON.stringify(payload) });
  await load();
  const assetLinkNote = result.asset_links_applied ? ` / 資産リンク ${result.asset_links_applied}件反映` : "";
  alert(result.status === "submitted" ? `ComfyUIへ送信しました${assetLinkNote}。` : `送信せず保存しました: ${result.error || result.status}${assetLinkNote}`);
}

async function ensureWorkflowRegistered() {
  const selected = $("#workflowSelect").value;
  if (!selected) return "";
  if (!selected.startsWith("discover:")) return selected;
  const relativePath = selected.replace("discover:", "");
  const registered = await api("/api/workflows/register", {
    method: "POST",
    body: JSON.stringify({ relative_path: relativePath }),
  });
  await load();
  $("#workflowSelect").value = registered.workflow_id;
  return registered.workflow_id;
}

async function regenerate(jobId) {
  if (!jobId) return;
  const result = await api(`/api/jobs/${jobId}/regenerate`, { method: "POST", body: "{}" });
  await load();
  alert(result.status === "submitted" ? "再生成を送信しました。" : "同条件の履歴を作成しました。");
}

async function pollJob(jobId) {
  const result = await api(`/api/jobs/${jobId}/poll`, { method: "POST", body: "{}" });
  await load();
  alert(`状態: ${result.status} / 出力 ${result.outputs || 0}`);
}

async function openAssetDetail(assetId) {
  const detail = await api(`/api/assets/${encodeURIComponent(assetId)}`);
  selectedAsset = detail.asset;
  const params = safeJson(selectedAsset.parameters_json);
  $("#detailImage").src = `/api/assets/${encodeURIComponent(assetId)}/file`;
  $("#detailStatus").value = selectedAsset.status || "candidate";
  $("#detailRating").value = selectedAsset.rating || 0;
  $("#detailScope").value = selectedAsset.content_scope || selectedAsset.safety_zone || "sfw";
  $("#detailTags").value = (selectedAsset.tags || []).join(" ");
  $("#detailNote").value = selectedAsset.note || "";
  $("#detailCompareNote").value = selectedAsset.comparison_note || "";
  $("#detailPrompt").textContent = selectedAsset.prompt || "";
  $("#detailNegative").textContent = selectedAsset.negative_prompt || "";
  $("#detailOpenImage").href = `/api/assets/${encodeURIComponent(assetId)}/file`;
  $("#detailInfo").innerHTML = `
    <dt>Workflow</dt><dd>${escapeHtml(selectedAsset.workflow_name || "-")}</dd>
    <dt>Seed</dt><dd>${escapeHtml(params.seed || "-")}</dd>
    <dt>Model / LoRA</dt><dd>${escapeHtml(`${params.model || "-"} / ${params.lora || "-"}`)}</dd>
    <dt>作成日時</dt><dd>${escapeHtml(selectedAsset.created_at || "-")}</dd>
    <dt>区分</dt><dd>${escapeHtml(selectedAsset.content_scope || selectedAsset.safety_zone || "sfw")}</dd>
    <dt>出力prefix</dt><dd>${escapeHtml(selectedAsset.output_prefix || "-")}</dd>
    <dt>保存先</dt><dd>${escapeHtml(selectedAsset.source_path || selectedAsset.relative_path || "-")}</dd>
  `;
  $("#assetDetail").classList.add("open");
  $("#assetDetail").setAttribute("aria-hidden", "false");
}

async function saveAssetDetail() {
  if (!selectedAsset) return;
  const payload = {
    status: $("#detailStatus").value,
    rating: Number($("#detailRating").value || 0),
    content_scope: $("#detailScope").value,
    tags: $("#detailTags").value,
    note: $("#detailNote").value,
    comparison_note: $("#detailCompareNote").value,
  };
  await api(`/api/assets/${encodeURIComponent(selectedAsset.asset_id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  await load();
  await openAssetDetail(selectedAsset.asset_id);
}

function closeAssetDetail() {
  $("#assetDetail").classList.remove("open");
  $("#assetDetail").setAttribute("aria-hidden", "true");
}

function openRecipeDialog(assetId) {
  const asset = state.assets.find((item) => item.asset_id === assetId) || selectedAsset;
  if (!asset) return;
  recipeSourceAsset = asset;
  const params = safeJson(asset.parameters_json);
  $("#recipeName").value = `${asset.workflow_name || "recipe"} seed ${params.seed || ""}`.trim();
  $("#recipeDescription").value = "";
  $("#recipeTags").value = (asset.tags || []).join(" ");
  $("#recipeSourceInfo").innerHTML = `
    <dt>元画像</dt><dd>${escapeHtml(asset.asset_id)}</dd>
    <dt>元ジョブ</dt><dd>${escapeHtml(asset.source_job_id || "-")}</dd>
    <dt>Workflow</dt><dd>${escapeHtml(asset.workflow_name || "-")}</dd>
  `;
  $("#recipeDialog").showModal();
}

async function saveRecipeFromDialog(event) {
  event.preventDefault();
  if (!recipeSourceAsset) return;
  const payload = {
    source_asset_id: recipeSourceAsset.asset_id,
    name: $("#recipeName").value,
    description: $("#recipeDescription").value,
    tags: $("#recipeTags").value,
  };
  await api("/api/recipes", { method: "POST", body: JSON.stringify(payload) });
  $("#recipeDialog").close();
  recipeSourceAsset = null;
  await load();
}

function openRecipeApplyDialog(recipeId) {
  if (!recipeId) return;
  pendingRecipeId = recipeId;
  const recipe = (state.recipes || []).find((item) => item.recipe_id === recipeId) || activeRecipe;
  $("#recipeApplyName").textContent = recipe?.name || recipeId;
  $("#recipeApplyDialog").showModal();
}

async function performRecipeApply(mode = "selected", saveDraft = false) {
  if (!pendingRecipeId) return;
  if (saveDraft) await saveCurrentDraft();
  const result = await api(`/api/recipes/${encodeURIComponent(pendingRecipeId)}/use`, { method: "POST", body: "{}" });
  const recipe = result.recipe;
  const params = safeJson(recipe.parameters_json);
  const form = $("#generateForm");
  const apply = {
    prompt: mode === "all" || $("#recipeApplyForm").elements.apply_prompt.checked,
    negative: mode === "all" || $("#recipeApplyForm").elements.apply_negative.checked,
    workflow: mode === "all" || $("#recipeApplyForm").elements.apply_workflow.checked,
    seed: mode === "all" || $("#recipeApplyForm").elements.apply_seed.checked,
    size: mode === "all" || $("#recipeApplyForm").elements.apply_size.checked,
    settings: mode === "all" || $("#recipeApplyForm").elements.apply_settings.checked,
  };
  if (apply.workflow && recipe.workflow_id) $("#workflowSelect").value = recipe.workflow_id;
  if (apply.prompt) form.elements.prompt.value = recipe.positive_prompt || "";
  if (apply.negative) form.elements.negative_prompt.value = recipe.negative_prompt || "";
  if (apply.seed && params.seed != null) form.elements.seed.value = params.seed;
  if (apply.size) {
    for (const key of ["width", "height"]) {
      if (form.elements[key] && params[key] != null) form.elements[key].value = params[key];
    }
  }
  if (apply.settings) {
    for (const key of ["batch_size", "steps", "cfg", "sampler", "scheduler", "model", "lora"]) {
      if (form.elements[key] && params[key] != null) form.elements[key].value = params[key];
    }
    if (form.elements.filename_prefix) form.elements.filename_prefix.value = params.requested_filename_prefix || "studio";
  }
  $("#recipeApplyDialog").close();
  pendingRecipeId = "";
  await load();
  switchView("generate");
}

async function saveCurrentDraft() {
  const form = new FormData($("#generateForm"));
  const payload = Object.fromEntries(form.entries());
  payload.workflow_id = null;
  payload.width = Number(payload.width);
  payload.height = Number(payload.height);
  payload.batch_size = Number(payload.batch_size);
  payload.steps = Number(payload.steps);
  payload.cfg = Number(payload.cfg);
  await api("/api/generate", { method: "POST", body: JSON.stringify(payload) });
}

async function applyRecipe(recipeId) {
  openRecipeApplyDialog(recipeId);
}

async function applyRecipeDirect(recipeId, mode = "all") {
  pendingRecipeId = recipeId;
  await performRecipeApply(mode);
}

async function quickUpdateAsset(assetId, status) {
  await api(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  await load();
}

async function duplicateRecipe(recipeId) {
  await api(`/api/recipes/${encodeURIComponent(recipeId)}/duplicate`, { method: "POST", body: "{}" });
  await load();
}

async function archiveRecipe(recipeId) {
  await api(`/api/recipes/${encodeURIComponent(recipeId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "archived" }),
  });
  await load();
}

function populateRecipeWorkflowSelect(selectedWorkflowId) {
  const select = $("#editRecipeWorkflow");
  select.innerHTML = `<option value="">Workflowなし</option>` + state.workflows
    .map((workflow) => `<option value="${escapeHtml(workflow.workflow_id)}">${escapeHtml(workflow.name)}</option>`)
    .join("");
  if ([...select.options].some((option) => option.value === selectedWorkflowId)) select.value = selectedWorkflowId || "";
}

async function openRecipeDetail(recipeId) {
  const result = await api(`/api/recipes/${encodeURIComponent(recipeId)}`);
  activeRecipe = result.recipe;
  const params = safeJson(activeRecipe.parameters_json);
  populateRecipeWorkflowSelect(activeRecipe.workflow_id || "");
  $("#editRecipeName").value = activeRecipe.name || "";
  $("#editRecipePrompt").value = activeRecipe.positive_prompt || "";
  $("#editRecipeNegative").value = activeRecipe.negative_prompt || "";
  $("#editRecipeSeed").value = params.seed || "";
  $("#editRecipeWidth").value = params.width || "";
  $("#editRecipeHeight").value = params.height || "";
  $("#editRecipeSteps").value = params.steps || "";
  $("#editRecipeCfg").value = params.cfg || "";
  $("#editRecipeTags").value = (activeRecipe.tags || []).join(" ");
  $("#editRecipeDescription").value = activeRecipe.description || "";
  $("#editRecipeInfo").innerHTML = `
    <dt>元画像</dt><dd>${escapeHtml(activeRecipe.source_asset_id || "-")}</dd>
    <dt>元ジョブ</dt><dd>${escapeHtml(activeRecipe.source_job_id || "-")}</dd>
    <dt>元ファイル</dt><dd>${escapeHtml(activeRecipe.source_file_name || activeRecipe.source_relative_path || "-")}</dd>
    <dt>最終更新</dt><dd>${escapeHtml(activeRecipe.updated_at || "-")}</dd>
  `;
  closeAssetDetail();
  closeCompareView();
  $("#recipeDetail").classList.add("open");
  $("#recipeDetail").setAttribute("aria-hidden", "false");
}

function recipeEditPayload(saveMode = "overwrite") {
  const params = safeJson(activeRecipe?.parameters_json);
  for (const [key, selector] of [
    ["seed", "#editRecipeSeed"],
    ["width", "#editRecipeWidth"],
    ["height", "#editRecipeHeight"],
    ["steps", "#editRecipeSteps"],
    ["cfg", "#editRecipeCfg"],
  ]) {
    const value = $(selector).value;
    params[key] = ["width", "height", "steps"].includes(key) ? Number(value || 0) : value;
  }
  return {
    save_mode: saveMode === "duplicate" ? "duplicate_version" : "overwrite",
    name: $("#editRecipeName").value,
    description: $("#editRecipeDescription").value,
    positive_prompt: $("#editRecipePrompt").value,
    negative_prompt: $("#editRecipeNegative").value,
    workflow_id: $("#editRecipeWorkflow").value || null,
    parameters: params,
    tags: $("#editRecipeTags").value,
  };
}

async function saveRecipeDetail(saveMode) {
  if (!activeRecipe) return;
  if (saveMode === "overwrite" && !confirm("元の再現条件を上書き保存しますか？")) return;
  const result = await api(`/api/recipes/${encodeURIComponent(activeRecipe.recipe_id)}`, {
    method: "PATCH",
    body: JSON.stringify(recipeEditPayload(saveMode)),
  });
  await load();
  await openRecipeDetail(result.recipe_id);
}

async function archiveActiveRecipe() {
  if (!activeRecipe) return;
  await archiveRecipe(activeRecipe.recipe_id);
  closeRecipeDetail();
}

function closeRecipeDetail() {
  $("#recipeDetail").classList.remove("open");
  $("#recipeDetail").setAttribute("aria-hidden", "true");
}

async function detectMapping() {
  const workflowId = await ensureWorkflowRegistered();
  if (!workflowId) {
    alert("Workflowを選択してください。");
    return;
  }
  mappingCandidates = await api(`/api/workflows/${encodeURIComponent(workflowId)}/mapping/candidates`);
  renderMappingTable();
  $("#mappingStatus").textContent = "候補を表示しました。保存するまで確定しません。";
}

async function saveMapping() {
  const workflowId = selectedRegisteredWorkflowId();
  if (!workflowId) {
    alert("登録済みWorkflowを選択してください。");
    return;
  }
  const mappings = $$("#mappingTable select")
    .filter((select) => select.value)
    .map((select) => {
      const [nodeId, inputKey] = select.value.split("::");
      const option = select.selectedOptions[0];
      return {
        field_key: select.dataset.fieldKey,
        node_id: nodeId,
        input_key: inputKey,
        input_type: option?.dataset.inputType || "text",
      };
    });
  const result = await api(`/api/workflows/${encodeURIComponent(workflowId)}/mapping`, {
    method: "POST",
    body: JSON.stringify({ mappings }),
  });
  await load();
  alert(`保存しました: ${result.saved_fields.join(", ")}`);
}

function safeJson(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindNavigation() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
}

function switchView(view) {
  closeAssetDetail();
  closeCompareView();
  closeRecipeDetail();
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.remove("active"));
  $(`#view-${view}`)?.classList.add("active");
  const nav = $(`.nav-item[data-view="${view}"]`);
  if (nav) $(".topbar h1").textContent = nav.textContent.trim();
  if (view === "board") searchBoard().catch((error) => alert(error.message));
}

function bindPanels() {
  $$(".dock-panel").forEach((panel) => {
    const key = `studio.panel.${panel.dataset.panel}`;
    if (localStorage.getItem(key) === "minimized") panel.classList.add("minimized");
    const icons = { promptTranslation: "P", ollama: "O", details: "D" };
    panel.querySelector("h2").dataset.icon = icons[panel.dataset.panel] || "P";
    panel.querySelector(".panel-toggle").addEventListener("click", async () => {
      panel.classList.toggle("minimized");
      localStorage.setItem(key, panel.classList.contains("minimized") ? "minimized" : "open");
      const panelState = Object.fromEntries($$(".dock-panel").map((item) => [item.dataset.panel, item.classList.contains("minimized") ? "minimized" : "open"]));
      await api("/api/settings/panel-state", { method: "POST", body: JSON.stringify(panelState) });
    });
  });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-regenerate]");
  if (button) regenerate(button.dataset.regenerate).catch((error) => alert(error.message));
  const pollButton = event.target.closest("[data-poll]");
  if (pollButton) pollJob(pollButton.dataset.poll).catch((error) => alert(error.message));
  const openAssetButton = event.target.closest("[data-open-asset]");
  if (openAssetButton) openAssetDetail(openAssetButton.dataset.openAsset).catch((error) => alert(error.message));
  const compareSelect = event.target.closest("[data-compare-select]");
  if (compareSelect) toggleCompareSelection(compareSelect.dataset.compareSelect, compareSelect.checked);
  const statusButton = event.target.closest("[data-status]");
  if (statusButton) {
    const [assetId, status] = statusButton.dataset.status.split(":");
    quickUpdateAsset(assetId, status).catch((error) => alert(error.message));
  }
  const useRecipeButton = event.target.closest("[data-use-recipe]");
  if (useRecipeButton) applyRecipe(useRecipeButton.dataset.useRecipe).catch((error) => alert(error.message));
  const editRecipeButton = event.target.closest("[data-edit-recipe]");
  if (editRecipeButton) openRecipeDetail(editRecipeButton.dataset.editRecipe).catch((error) => alert(error.message));
  const duplicateRecipeButton = event.target.closest("[data-duplicate-recipe]");
  if (duplicateRecipeButton) duplicateRecipe(duplicateRecipeButton.dataset.duplicateRecipe).catch((error) => alert(error.message));
  const archiveRecipeButton = event.target.closest("[data-archive-recipe]");
  if (archiveRecipeButton) archiveRecipe(archiveRecipeButton.dataset.archiveRecipe).catch((error) => alert(error.message));
  const viewJump = event.target.closest("[data-view-jump]");
  if (viewJump) switchView(viewJump.dataset.viewJump);
  const compareSaveButton = event.target.closest("[data-compare-save]");
  if (compareSaveButton) saveCompareAsset(compareSaveButton.dataset.compareSave).catch((error) => alert(error.message));
  const recipeFromAssetButton = event.target.closest("[data-recipe-from-asset]");
  if (recipeFromAssetButton) openRecipeDialog(recipeFromAssetButton.dataset.recipeFromAsset);
  const openComparisonButton = event.target.closest("[data-open-comparison]");
  if (openComparisonButton) openComparison(openComparisonButton.dataset.openComparison).catch((error) => alert(error.message));
  const renameComparisonButton = event.target.closest("[data-rename-comparison]");
  if (renameComparisonButton) renameComparison(renameComparisonButton.dataset.renameComparison).catch((error) => alert(error.message));
  const duplicateComparisonButton = event.target.closest("[data-duplicate-comparison]");
  if (duplicateComparisonButton) duplicateComparison(duplicateComparisonButton.dataset.duplicateComparison).catch((error) => alert(error.message));
  const archiveComparisonButton = event.target.closest("[data-archive-comparison]");
  if (archiveComparisonButton) archiveComparison(archiveComparisonButton.dataset.archiveComparison).catch((error) => alert(error.message));
  const addStorageScopeButton = event.target.closest("[data-add-storage-scope]");
  if (addStorageScopeButton) openStorageDialog(addStorageScopeButton.dataset.addStorageScope);
  const editStorageButton = event.target.closest("[data-edit-storage]");
  if (editStorageButton) openStorageDialog("general", editStorageButton.dataset.editStorage);
  const testStorageButton = event.target.closest("[data-test-storage]");
  if (testStorageButton) testStorage(testStorageButton.dataset.testStorage).catch((error) => alert(error.message));
  const toggleStorageButton = event.target.closest("[data-toggle-storage]");
  if (toggleStorageButton) {
    const [storageId, enabled] = toggleStorageButton.dataset.toggleStorage.split(":");
    api(`/api/storage/${encodeURIComponent(storageId)}`, { method: "PATCH", body: JSON.stringify({ is_enabled: enabled === "1" }) })
      .then(load)
      .catch((error) => alert(error.message));
  }
  const exportCandidateButton = event.target.closest("[data-export-candidate]");
  if (exportCandidateButton) toggleExportCandidate(exportCandidateButton.dataset.exportCandidate).catch((error) => alert(error.message));
  const editTranslationButton = event.target.closest("[data-edit-translation-term]");
  if (editTranslationButton) editTranslationTerm(editTranslationButton.dataset.editTranslationTerm).catch((error) => alert(error.message));
  const toggleTranslationButton = event.target.closest("[data-toggle-translation-term]");
  if (toggleTranslationButton) {
    const [termId, enabled] = toggleTranslationButton.dataset.toggleTranslationTerm.split(":");
    toggleTranslationTerm(termId, enabled === "1").catch((error) => alert(error.message));
  }
  const reuseTranslationButton = event.target.closest("[data-reuse-translation-history]");
  if (reuseTranslationButton) reuseTranslationHistory(reuseTranslationButton.dataset.reuseTranslationHistory);
  const editRegistryButton = event.target.closest("[data-edit-registry-item]");
  if (editRegistryButton) openAssetRegistryItem(editRegistryButton.dataset.editRegistryItem);
  const applyCivitaiButton = event.target.closest("#applyCivitaiToAsset");
  if (applyCivitaiButton) applyCivitaiToAsset().catch((error) => alert(error.message));
  const planCivitaiButton = event.target.closest("#planCivitaiDownload");
  if (planCivitaiButton) planCivitaiDownload().catch((error) => alert(error.message));
  const downloadCivitaiButton = event.target.closest("#downloadCivitaiAsset");
  if (downloadCivitaiButton) downloadCivitaiAsset().catch((error) => alert(error.message));
  const cancelCivitaiButton = event.target.closest("#cancelCivitaiDownload");
  if (cancelCivitaiButton) cancelCivitaiDownload().catch((error) => alert(error.message));
  const linkWorkflowAssetButton = event.target.closest("[data-link-workflow-asset]");
  if (linkWorkflowAssetButton) linkWorkflowRequirementAsset(linkWorkflowAssetButton.dataset.linkWorkflowAsset).catch((error) => alert(error.message));
  const clearWorkflowAssetButton = event.target.closest("[data-clear-workflow-asset]");
  if (clearWorkflowAssetButton) clearWorkflowRequirementAsset(clearWorkflowAssetButton.dataset.clearWorkflowAsset).catch((error) => alert(error.message));
  const openRestoreButton = event.target.closest("#openDatabaseRestoreDialog");
  if (openRestoreButton) openDatabaseRestoreDialog().catch((error) => alert(error.message));
  const setupActionButton = event.target.closest("[data-setup-action]");
  if (setupActionButton) runSetupAction(setupActionButton.dataset.setupAction).catch((error) => alert(error.message));
  const setupStateButton = event.target.closest("[data-setup-state]");
  if (setupStateButton) saveSetupWizardState(setupStateButton.dataset.setupState).catch((error) => alert(error.message));
});

document.addEventListener("change", (event) => {
  const boardNote = event.target.closest("[data-board-note]");
  if (boardNote) saveBoardNote(boardNote.dataset.boardNote, boardNote.value).catch((error) => alert(error.message));
});

$("#generateForm").addEventListener("submit", (event) => submitGeneration(event).catch((error) => alert(error.message)));
$("#civitaiKeyForm").addEventListener("submit", (event) => saveCivitaiKey(event).catch((error) => alert(error.message)));
$("#testCivitaiKey").addEventListener("click", () => testCivitaiKey().catch((error) => alert(error.message)));
$("#deleteCivitaiKey").addEventListener("click", () => deleteCivitaiKey().catch((error) => alert(error.message)));
$("#civitaiLookupForm").addEventListener("submit", (event) => lookupCivitai(event).catch((error) => {
  $("#civitaiPreview").innerHTML = `<div class="empty-state">取得できませんでした: ${escapeHtml(error.message)}</div>`;
}));
$("#scanAssetRegistry").addEventListener("click", () => scanAssetRegistry().catch((error) => alert(error.message)));
$("#scanWorkflowRequirements").addEventListener("click", () => scanWorkflowRequirements().catch((error) => alert(error.message)));
$("#assetLocationForm").addEventListener("submit", (event) => saveAssetLocation(event).catch((error) => alert(error.message)));
$("#assetRegistryItemForm").addEventListener("submit", (event) => saveAssetRegistryItem(event).catch((error) => alert(error.message)));
$("#cancelAssetRegistryItem").addEventListener("click", () => { activeAssetRegistryItem = null; $("#assetRegistryItemDialog").close(); });
$("#refreshButton").addEventListener("click", async () => {
  await api("/api/jobs/poll", { method: "POST", body: "{}" }).catch(() => null);
  await load();
});
$("#workflowSelect").addEventListener("change", () => {
  mappingCandidates = null;
  renderMappingTable();
  renderAssetLinkPreview();
});
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", updateScopeWarning));
$("#recipeSelect").addEventListener("change", (event) => applyRecipe(event.target.value).catch((error) => alert(error.message)));
$$("#scopeTabs [data-scope-tab]").forEach((button) => button.addEventListener("click", () => setScopeTab(button.dataset.scopeTab)));
$("#toggleLibraryFilters").addEventListener("click", () => { $("#libraryFilters").hidden = !$("#libraryFilters").hidden; });
$("#assetSearch").addEventListener("input", () => searchAssets().catch((error) => alert(error.message)));
for (const selector of ["#filterStatus", "#filterRating", "#filterTags", "#filterWorkflow", "#filterRecipe", "#filterPeriod", "#filterScope"]) {
  $(selector).addEventListener("change", () => searchAssets().catch((error) => alert(error.message)));
}
$("#clearLibraryFilters").addEventListener("click", clearLibraryFilters);
for (const selector of ["#boardFilterTags", "#boardFilterWorkflow", "#boardFilterRecipe", "#boardFilterScope", "#boardFilterRating"]) {
  $(selector).addEventListener("change", () => searchBoard().catch((error) => alert(error.message)));
}
$("#clearBoardFilters").addEventListener("click", () => {
  for (const selector of ["#boardFilterWorkflow", "#boardFilterRecipe", "#boardFilterScope", "#boardFilterRating"]) $(selector).value = "";
  [...$("#boardFilterTags").options].forEach((option) => { option.selected = false; });
  searchBoard().catch((error) => alert(error.message));
});
$$("[data-quick-filter]").forEach((button) => button.addEventListener("click", () => {
  $$(".quick-filters .filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  searchAssets(button.dataset.quickFilter).catch((error) => alert(error.message));
}));
$("#openCompare").addEventListener("click", openCompareView);
$("#closeCompare").addEventListener("click", closeCompareView);
$("#saveCompare").addEventListener("click", () => saveComparisonSet().catch((error) => alert(error.message)));
$("#resyncJobs").addEventListener("click", () => resyncJobs().catch((error) => alert(error.message)));
$("#createDbBackup").addEventListener("click", () => createDatabaseBackup().catch((error) => alert(error.message)));
$("#databaseRestoreForm").addEventListener("submit", (event) => restoreDatabaseBackup(event).catch((error) => alert(error.message)));
$("#cancelDatabaseRestore").addEventListener("click", () => $("#databaseRestoreDialog").close());
$("#shutdownStudio").addEventListener("click", () => shutdownStudio().catch((error) => alert(error.message)));
$("#openStorageDialog").addEventListener("click", () => openStorageDialog("general"));
$("#detectMapping").addEventListener("click", () => detectMapping().catch((error) => alert(error.message)));
$("#saveMapping").addEventListener("click", () => saveMapping().catch((error) => alert(error.message)));
$("#testMappingSend").addEventListener("click", () => $("#generateForm").requestSubmit());
$("#convertPromptTranslation").addEventListener("click", () => convertPromptTranslation().catch((error) => {
  $("#translationStatus").textContent = `変換できませんでした: ${error.message}`;
}));
$("#applyPromptTranslation").addEventListener("click", applyPromptTranslation);
$("#openTranslationTerms").addEventListener("click", () => openTranslationTerms().catch((error) => alert(error.message)));
$("#openTranslationHistory").addEventListener("click", () => openTranslationHistory().catch((error) => alert(error.message)));
$("#translationTermSearch").addEventListener("input", renderTranslationTerms);
$("#translationTermForm").addEventListener("submit", (event) => saveTranslationTerm(event).catch((error) => alert(error.message)));
$("#refreshTranslationTerms").addEventListener("click", () => refreshTranslationTerms().catch((error) => alert(error.message)));
$("#refreshTranslationHistory").addEventListener("click", () => refreshTranslationHistory().catch((error) => alert(error.message)));
$("#closeTranslationTerms").addEventListener("click", () => $("#translationTermsDialog").close());
$("#closeTranslationHistory").addEventListener("click", () => $("#translationHistoryDialog").close());
$("#closeAssetDetail").addEventListener("click", closeAssetDetail);
$("#saveAssetDetail").addEventListener("click", () => saveAssetDetail().catch((error) => alert(error.message)));
$("#detailRegenerate").addEventListener("click", () => selectedAsset && regenerate(selectedAsset.source_job_id).catch((error) => alert(error.message)));
$("#detailSaveRecipe").addEventListener("click", () => selectedAsset && openRecipeDialog(selectedAsset.asset_id));
$("#closeRecipeDetail").addEventListener("click", closeRecipeDetail);
$("#saveRecipeOverwrite").addEventListener("click", () => saveRecipeDetail("overwrite").catch((error) => alert(error.message)));
$("#saveRecipeVersion").addEventListener("click", () => saveRecipeDetail("duplicate").catch((error) => alert(error.message)));
$("#applyRecipeDetail").addEventListener("click", () => activeRecipe && applyRecipe(activeRecipe.recipe_id).catch((error) => alert(error.message)));
$("#archiveRecipeDetail").addEventListener("click", () => archiveActiveRecipe().catch((error) => alert(error.message)));
$("#applyRecipeAll").addEventListener("click", () => performRecipeApply("all").catch((error) => alert(error.message)));
$("#applyRecipeSelected").addEventListener("click", () => performRecipeApply("selected").catch((error) => alert(error.message)));
$("#applyRecipeDraft").addEventListener("click", () => performRecipeApply("selected", true).catch((error) => alert(error.message)));
$("#cancelRecipeApply").addEventListener("click", () => { pendingRecipeId = ""; $("#recipeApplyDialog").close(); $("#recipeSelect").value = ""; });
$("#recipeForm").addEventListener("submit", (event) => saveRecipeFromDialog(event).catch((error) => alert(error.message)));
$("#cancelRecipeDialog").addEventListener("click", () => $("#recipeDialog").close());
$("#storageForm").addEventListener("submit", (event) => saveStorage(event).catch((error) => alert(error.message)));
$("#testStoragePath").addEventListener("click", () => testStorage().catch((error) => alert(error.message)));
$("#cancelStorageDialog").addEventListener("click", () => $("#storageDialog").close());
$("#ollamaDraft").addEventListener("click", () => alert("Ollama提案APIは次段階です。接続設定とモデル検出は実装済みです。"));
$("#saveRecipe").addEventListener("click", () => alert("生成済み画像の詳細画面からレシピ保存できます。"));

bindNavigation();
bindPanels();
load().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.message)}</pre>`;
});
