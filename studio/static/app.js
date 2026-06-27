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
  renderStorage();
  renderMappingTable();
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

function renderModels() {
  const list = $("#modelList");
  const models = state.connections.ollama.models || [];
  if (!models.length) {
    list.innerHTML = `<div class="empty-state">Ollamaモデル一覧を取得できませんでした。</div>`;
    return;
  }
  list.innerHTML = models.map((model) => `<span class="chip ok">${escapeHtml(model)}</span>`).join("");
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
  alert(result.status === "submitted" ? "ComfyUIへ送信しました。" : `送信せず保存しました: ${result.error || result.status}`);
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
    panel.querySelector("h2").dataset.icon = panel.dataset.panel === "ollama" ? "O" : "D";
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
});

document.addEventListener("change", (event) => {
  const boardNote = event.target.closest("[data-board-note]");
  if (boardNote) saveBoardNote(boardNote.dataset.boardNote, boardNote.value).catch((error) => alert(error.message));
});

$("#generateForm").addEventListener("submit", (event) => submitGeneration(event).catch((error) => alert(error.message)));
$("#refreshButton").addEventListener("click", async () => {
  await api("/api/jobs/poll", { method: "POST", body: "{}" }).catch(() => null);
  await load();
});
$("#workflowSelect").addEventListener("change", () => {
  mappingCandidates = null;
  renderMappingTable();
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
$("#openStorageDialog").addEventListener("click", () => openStorageDialog("general"));
$("#detectMapping").addEventListener("click", () => detectMapping().catch((error) => alert(error.message)));
$("#saveMapping").addEventListener("click", () => saveMapping().catch((error) => alert(error.message)));
$("#testMappingSend").addEventListener("click", () => $("#generateForm").requestSubmit());
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
