const STORAGE_KEYS = {
  inventory: "inventory-items",
  report: "daily-report",
  photo: "inventory-photo",
};

const API_BASE = resolveBackendOrigin();
const API_ENDPOINTS = {
  state: `${API_BASE}/state`,
  vision: `${API_BASE}/vision/analyze`,
};

const PERSIST_DEBOUNCE_MS = 800;
const MAX_COUNT_SELECT = 20;
const MATERIAL_TIME_STEP_MINUTES = 30;
let persistTimer = null;

const defaultInventory = buildDefaultInventory();

const defaultReport = {
  loss: "0",
  setCount: "0",
  operationHours: "0",
  sales: "0",
  insights: "",
  materialReceivedAt: "",
};

const state = {
  inventory: [],
  report: { ...defaultReport },
  photo: null,
};

const dragState = {
  row: null,
};

const elements = {
  inventoryBody: document.getElementById("inventory-rows"),
  addItemButton: document.getElementById("add-item"),
  photoInput: document.getElementById("inventory-photo"),
  photoPreview: document.getElementById("photo-preview"),
  previewImg: document.getElementById("preview-img"),
  removePhotoButton: document.getElementById("remove-photo"),
  reportForm: document.getElementById("report-form"),
  linePreview: document.getElementById("line-preview"),
  copyButton: document.getElementById("copy-message"),
  copyStatus: document.getElementById("copy-status"),
};

init();

async function init() {
  await bootstrapState();
  renderInventoryRows();
  hydrateReportForm();
  hydratePhotoPreview();
  attachEventListeners();
  updateLinePreview();
}

function attachEventListeners() {
  elements.addItemButton?.addEventListener("click", addInventoryRow);
  elements.photoInput?.addEventListener("change", handlePhotoChange);
  elements.removePhotoButton?.addEventListener("click", removePhoto);
  elements.inventoryBody?.addEventListener("dragover", handleBodyDragOver);

  if (elements.reportForm) {
    const reportFields = [
      "loss",
      "set-count",
      "operation-hours",
      "sales",
      "insights",
    ];
    reportFields.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("input", () => {
        const key = camelCase(id);
        state.report[key] = input.value;
        queuePersistState();
        updateLinePreview();
      });
    });
    initializeMaterialReceivedControls();
  }

  elements.copyButton?.addEventListener("click", copyMessageToClipboard);
}

function renderInventoryRows() {
  if (!elements.inventoryBody) return;
  elements.inventoryBody.innerHTML = "";

  state.inventory.forEach((item) => {
    const tr = document.createElement("tr");
    tr.classList.add("inventory-row");
    tr.dataset.id = item.id;
    tr.addEventListener("dragover", handleRowDragOver);
    tr.addEventListener("dragenter", handleRowDragEnter);
    tr.addEventListener("drop", handleRowDrop);

    const nameTd = document.createElement("td");
    nameTd.dataset.label = "材料名";
    nameTd.classList.add("cell-name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name ?? "";
    nameInput.placeholder = "材料名";
    let isComposing = false;
    const commitName = () => {
      updateInventoryItem(item.id, { name: nameInput.value }, tr);
    };
    nameInput.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    nameInput.addEventListener("compositionend", () => {
      isComposing = false;
      commitName();
    });
    nameInput.addEventListener("input", () => {
      if (isComposing) return;
      commitName();
    });
    nameTd.appendChild(nameInput);

    const idealTd = document.createElement("td");
    idealTd.dataset.label = "理想";
    idealTd.classList.add("cell-ideal");
    const idealSelect = createCountSelect(item.ideal ?? 0, (nextValue) => {
      updateInventoryItem(
        item.id,
        {
          ideal: nextValue,
        },
        tr,
      );
    });
    idealTd.appendChild(idealSelect);

    const currentTd = document.createElement("td");
    currentTd.dataset.label = "現在庫";
    currentTd.classList.add("cell-current");
    const currentSelect = createCountSelect(
      item.current ?? 0,
      (nextValue) => {
        updateInventoryItem(
          item.id,
          {
            current: nextValue,
          },
          tr,
        );
      },
      { step: 0.5 },
    );
    currentTd.appendChild(currentSelect);

    const shortageTd = document.createElement("td");
    shortageTd.dataset.label = "不足";
    shortageTd.classList.add("cell-shortage");
    shortageTd.dataset.role = "shortage";
    shortageTd.textContent = formatShortage(item);
    setShortageAlert(shortageTd, item);

    const actionsTd = document.createElement("td");
    actionsTd.classList.add("row-actions", "cell-actions");
    const dragHandle = createDragHandle(tr);
    const deleteButton = createActionButton("削除", "行を削除", () =>
      removeInventoryItem(item.id),
    );
    actionsTd.append(dragHandle, deleteButton);

    tr.append(nameTd, idealTd, currentTd, shortageTd, actionsTd);
    elements.inventoryBody.appendChild(tr);
  });
}

function updateInventoryItem(id, patch, rowElement) {
  state.inventory = state.inventory.map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  queuePersistState();
  if (rowElement) {
    updateShortageCell(id, rowElement);
  } else {
    renderInventoryRows();
  }
  updateLinePreview();
}

function updateShortageCell(id, rowElement) {
  const shortageCell =
    rowElement.querySelector('[data-role="shortage"]') || rowElement.lastChild;
  if (!shortageCell) return;
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item) {
    shortageCell.textContent = "";
    shortageCell.classList.remove("is-shortage");
    return;
  }
  shortageCell.textContent = formatShortage(item);
  setShortageAlert(shortageCell, item);
}

function addInventoryRow() {
  const newItem = {
    id: generateId(),
    name: "新しい材料",
    ideal: 0,
    current: 0,
  };
  state.inventory = [...state.inventory, newItem];
  queuePersistState();
  renderInventoryRows();
}

function removeInventoryItem(id) {
  state.inventory = state.inventory.filter((item) => item.id !== id);
  if (!state.inventory.length) {
    state.inventory = clone(defaultInventory);
  }
  queuePersistState();
  renderInventoryRows();
  updateLinePreview();
}

function handlePhotoChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    removePhoto();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    state.photo = {
      dataUrl: reader.result,
      name: file.name,
      updatedAt: Date.now(),
    };
    queuePersistState();
    hydratePhotoPreview();
    updateLinePreview();
    // send the photo to backend for analysis and merge results
    analyzePhoto(file).catch((err) => {
      console.error("Vision analyze failed:", err);
    });
  };
  reader.readAsDataURL(file);
}

async function analyzePhoto(file) {
  const form = new FormData();
  form.append("image", file, file.name);
  // optional instructions; backend has defaults
  form.append(
    "instructions",
    "Detect which takoyaki ingredients are running low. Output JSON list with name, ideal, current."
  );

  const res = await fetch(API_ENDPOINTS.vision, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`analysis failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.inventory)) {
    throw new Error("invalid response from vision API");
  }

  // Merge returned inventory into local state: match by name when possible
  const returned = data.inventory.map((it) => ({
    id: generateId(),
    name: it.name ?? "不明",
    ideal: typeof it.ideal === "number" ? it.ideal : 0,
    current: typeof it.current === "number" ? it.current : 0,
  }));

  // Update existing items where names match (fuzzy match: exact)
  const updated = [...state.inventory];
  returned.forEach((item) => {
    const idx = updated.findIndex((exist) => exist.name === item.name);
    if (idx !== -1) {
      updated[idx] = { ...updated[idx], ...item };
    } else {
      updated.push(item);
    }
  });

  state.inventory = sanitizeInventory(updated);
  queuePersistState();
  renderInventoryRows();
  updateLinePreview();

  // Optionally show model notes
  if (data.notes) {
    console.info("Vision notes:", data.notes);
  }
}

function hydratePhotoPreview() {
  if (!elements.photoPreview || !elements.previewImg) return;
  const hasPhoto = Boolean(state.photo?.dataUrl);
  elements.photoPreview.classList.toggle("hidden", !hasPhoto);
  if (hasPhoto) {
    elements.previewImg.src = state.photo.dataUrl;
    elements.previewImg.alt = state.photo.name ?? "棚の写真";
  } else {
    elements.previewImg.removeAttribute("src");
  }
}

function removePhoto() {
  state.photo = null;
  elements.photoInput.value = "";
  queuePersistState();
  hydratePhotoPreview();
  updateLinePreview();
}

function hydrateReportForm() {
  const mapping = {
    loss: "loss",
    "set-count": "setCount",
    "operation-hours": "operationHours",
    sales: "sales",
    insights: "insights",
  };
  Object.entries(mapping).forEach(([inputId, key]) => {
    const el = document.getElementById(inputId);
    if (el) el.value = state.report[key] ?? "";
  });
  const materialDateInput = document.getElementById("material-received-date");
  const materialTimeSelect = document.getElementById("material-received-time");
  if (materialTimeSelect) {
    ensureMaterialTimeOptions(materialTimeSelect);
  }
  const parsedMaterial = parseMaterialReceivedAt(
    state.report.materialReceivedAt,
  );
  if (materialDateInput) {
    materialDateInput.value = parsedMaterial?.date ?? "";
  }
  if (materialTimeSelect) {
    materialTimeSelect.value = parsedMaterial?.time ?? "";
  }
}

function initializeMaterialReceivedControls() {
  const materialDateInput = document.getElementById("material-received-date");
  const materialTimeSelect = document.getElementById("material-received-time");
  if (!materialDateInput && !materialTimeSelect) {
    return;
  }
  if (materialTimeSelect) {
    ensureMaterialTimeOptions(materialTimeSelect);
  }
  const handleChange = () => {
    const dateValue = materialDateInput?.value || "";
    const timeValue = materialTimeSelect?.value || "";
    state.report.materialReceivedAt =
      dateValue && timeValue ? `${dateValue}T${timeValue}` : "";
    queuePersistState();
    updateLinePreview();
  };
  materialDateInput?.addEventListener("change", handleChange);
  materialTimeSelect?.addEventListener("change", handleChange);
}

function updateLinePreview() {
  if (!elements.linePreview) return;
  const message = buildLineMessage();
  elements.linePreview.value = message;
}

function buildLineMessage() {
  const lines = [];
  lines.push("【日報】");
  lines.push(formatReportNumber(state.report.loss));
  lines.push(formatReportNumber(state.report.setCount));
  lines.push(formatReportNumber(state.report.operationHours));
  lines.push("");
  lines.push(formatCurrency(state.report.sales));
  lines.push("");
  lines.push(formatInsightsText(state.report.insights));

  const materialLine = buildMaterialReceivedMessage(
    state.report.materialReceivedAt,
  );
  if (materialLine) {
    lines.push("", materialLine);
  }

  const shortageLines = buildShortageRequestLines();
  if (shortageLines.length) {
    lines.push("", ...shortageLines);
  }

  return lines.join("\n");
}

async function copyMessageToClipboard() {
  if (!elements.linePreview) return;
  const text = elements.linePreview.value;
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text, elements.linePreview);
    }
    showCopyStatus("コピーしました");
  } catch (error) {
    console.error(error);
    showCopyStatus("コピーに失敗しました");
  }
}

function fallbackCopy(text, textarea) {
  const previousSelection = {
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
  };
  textarea.select();
  document.execCommand("copy");
  textarea.setSelectionRange(previousSelection.start, previousSelection.end);
}

function showCopyStatus(message) {
  if (!elements.copyStatus) return;
  elements.copyStatus.textContent = message;
  setTimeout(() => {
    elements.copyStatus.textContent = "";
  }, 2000);
}

function formatShortage(item) {
  const shortage = getShortageAmount(item);
  return shortage > 0 ? `${shortage}` : "OK";
}

function getShortageAmount(item) {
  if (!item) return 0;
  const shortageValue = Math.max(0, (item.ideal ?? 0) - (item.current ?? 0));
  return Math.ceil(shortageValue);
}

function setShortageAlert(cell, item) {
  if (!cell) return;
  cell.classList.toggle("is-shortage", getShortageAmount(item) > 0);
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value) {
  const numeric = parseNumber(value, 0);
  return numeric.toLocaleString("ja-JP");
}

function formatReportNumber(value) {
  const raw = typeof value === "number" ? value : parseNumber(value, NaN);
  if (Number.isFinite(raw)) {
    return String(raw);
  }
  const fallback = typeof value === "string" ? value.trim() : "";
  return fallback || "0";
}

function formatInsightsText(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "特記事項なし。";
}

function ensureMaterialTimeOptions(select) {
  if (select.dataset.initialized === "true") return;
  populateMaterialTimeOptions(select);
  select.dataset.initialized = "true";
}

function populateMaterialTimeOptions(select) {
  select.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "未設定";
  select.appendChild(emptyOption);
  const totalMinutesInDay = 24 * 60;
  for (
    let minutes = 0;
    minutes < totalMinutesInDay;
    minutes += MATERIAL_TIME_STEP_MINUTES
  ) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const label = `${padTimeSegment(hours)}:${padTimeSegment(mins)}`;
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    select.appendChild(option);
  }
}

function padTimeSegment(value) {
  return value.toString().padStart(2, "0");
}

function sanitizeInventory(items) {
  if (!Array.isArray(items) || !items.length) {
    return clone(defaultInventory);
  }
  return items.map((item) => ({
    id: item?.id ?? generateId(),
    name: typeof item?.name === "string" ? item.name : "",
    ideal: normalizeCount(item?.ideal),
    current: normalizeCount(item?.current),
  }));
}

function sanitizeInventoryOptional(items) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  return items.map((item) => ({
    id: item?.id ?? generateId(),
    name: typeof item?.name === "string" ? item.name : "",
    ideal: normalizeCount(item?.ideal),
    current: normalizeCount(item?.current),
  }));
}

function normalizeCount(value) {
  return Math.max(0, parseNumber(value, 0));
}

function parseMaterialReceivedAt(value) {
  if (typeof value !== "string" || !value.includes("T")) {
    return null;
  }
  const [date, timePart] = value.split("T");
  if (!date || !timePart) return null;
  const time = timePart.slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  return { date, time };
}

function createActionButton(label, title, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", handler);
  return button;
}

function createCountSelect(value, onChange, options = {}) {
  const step =
    typeof options.step === "number" && options.step > 0 ? options.step : 1;
  const select = document.createElement("select");
  select.classList.add("count-select");
  const sanitized = Math.max(0, parseNumber(value, 0));
  const decimals = getDecimalPlaces(step);
  const totalSteps = Math.ceil(MAX_COUNT_SELECT / step);
  for (let i = 0; i <= totalSteps; i += 1) {
    const numericValue = Math.min(MAX_COUNT_SELECT, i * step);
    const optionValue = formatCountOptionValue(numericValue, decimals);
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    select.appendChild(option);
  }
  const needsCustomOption =
    sanitized > MAX_COUNT_SELECT || !isMultipleOfStep(sanitized, step);
  if (needsCustomOption) {
    const extraOption = document.createElement("option");
    extraOption.value = String(sanitized);
    extraOption.textContent = String(sanitized);
    select.appendChild(extraOption);
  }
  if (needsCustomOption) {
    select.value = String(sanitized);
  } else {
    const initialValue = Math.min(sanitized, MAX_COUNT_SELECT);
    select.value = formatCountOptionValue(initialValue, decimals);
  }
  select.addEventListener("change", () => {
    onChange(parseNumber(select.value, 0));
  });
  return select;
}

function getDecimalPlaces(value) {
  const str = String(value);
  const decimalIndex = str.indexOf(".");
  return decimalIndex === -1 ? 0 : str.length - decimalIndex - 1;
}

function formatCountOptionValue(value, decimals) {
  if (decimals <= 0) {
    return String(Math.round(value));
  }
  const normalized = Number(value.toFixed(decimals));
  return String(normalized);
}

function isMultipleOfStep(value, step) {
  if (step <= 0) return true;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

function buildMaterialReceivedMessage(value) {
  const parsed = parseMaterialReceivedAt(value);
  if (!parsed) return "";
  const formattedDate = formatMaterialReceivedDate(parsed.date);
  return `${formattedDate} ${parsed.time}ごろに材料受け取り予定です。`;
}

function formatMaterialReceivedDate(dateString) {
  const parts = dateString.split("-");
  if (parts.length !== 3) return dateString;
  const [year, month, day] = parts;
  const numMonth = Number(month);
  const numDay = Number(day);
  if (!Number.isFinite(numMonth) || !Number.isFinite(numDay)) {
    return dateString;
  }
  return `${year}/${numMonth}/${numDay}`;
}

function buildShortageRequestLines() {
  const shortageItems = state.inventory
    .map((item) => ({
      ...item,
      shortage: getShortageAmount(item),
    }))
    .filter((item) => item.shortage > 0);
  if (!shortageItems.length) {
    return ["【必要材料】なし（理想在庫クリア）"];
  }
  const lines = ["【必要材料】"];
  shortageItems.forEach((item) => {
    lines.push(`${item.name}：${item.shortage}`);
  });
  return lines;
}

function createDragHandle(row) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.classList.add("drag-handle");
  handle.setAttribute("draggable", "true");
  handle.title = "ドラッグで並び替え";
  handle.textContent = "⇅";
  handle.addEventListener("dragstart", (event) =>
    handleRowDragStart(event, row),
  );
  handle.addEventListener("dragend", handleRowDragEnd);
  return handle;
}

function handleRowDragStart(event, row) {
  dragState.row = row;
  row.classList.add("dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", row.dataset.id ?? "");
    } catch (error) {
      /* noop */
    }
  }
}

function handleRowDragEnter(event) {
  if (!dragState.row) return;
  event.preventDefault();
}

function handleRowDragOver(event) {
  if (!dragState.row) return;
  event.preventDefault();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const draggingRow = dragState.row;
  if (target === draggingRow) return;
  const rect = target.getBoundingClientRect();
  const shouldInsertBefore = event.clientY < rect.top + rect.height / 2;
  const tbody = target.parentElement;
  if (!tbody) return;
  if (shouldInsertBefore) {
    tbody.insertBefore(draggingRow, target);
  } else {
    tbody.insertBefore(draggingRow, target.nextSibling);
  }
}

function handleRowDrop(event) {
  if (!dragState.row) return;
  event.preventDefault();
  handleRowDragOver(event);
}

function handleBodyDragOver(event) {
  if (!dragState.row) return;
  event.preventDefault();
  const tbody = event.currentTarget;
  if (!(tbody instanceof HTMLElement)) return;
  if (event.target === tbody && dragState.row.parentElement !== tbody) {
    tbody.appendChild(dragState.row);
  }
}

function handleRowDragEnd() {
  if (!dragState.row) return;
  dragState.row.classList.remove("dragging");
  applyDraggedOrder();
  dragState.row = null;
}

function applyDraggedOrder() {
  if (!elements.inventoryBody) return;
  const orderedIds = Array.from(
    elements.inventoryBody.querySelectorAll("tr"),
  ).map((row) => row.dataset.id);
  if (!orderedIds.length) return;
  const nextInventory = orderedIds
    .map((id) => state.inventory.find((item) => item.id === id))
    .filter(Boolean);
  if (nextInventory.length !== state.inventory.length) return;
  state.inventory = nextInventory;
  queuePersistState();
  renderInventoryRows();
  updateLinePreview();
}

function camelCase(id) {
  return id.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `item-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn(`Failed to read ${key}`, error);
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to write ${key}`, error);
  }
}

async function bootstrapState() {
  try {
    const remote = await fetchStateFromServer();
    const localSnapshot = readLocalStateSnapshot();
    if (localSnapshot.inventory.length > 0) {
      state.inventory = localSnapshot.inventory;
      state.report = localSnapshot.report;
      state.photo = localSnapshot.photo;
      persistStateLocally();
      try {
        await pushStateToServer();
      } catch (error) {
        console.warn("Failed to seed backend state from local snapshot", error);
      }
      return;
    }
    const remoteHasInventory =
      Array.isArray(remote?.inventory) && remote.inventory.length > 0;
    if (remoteHasInventory) {
      applyStatePayload(remote);
      persistStateLocally();
      return;
    }
    applyStatePayload(remote);
    persistStateLocally();
  } catch (error) {
    console.warn("Falling back to local state", error);
    loadStateFromLocalStorage();
  }
}

async function fetchStateFromServer() {
  const res = await fetch(API_ENDPOINTS.state, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`state fetch failed: ${res.status} ${text}`);
  }
  return res.json();
}

function loadStateFromLocalStorage() {
  const snapshot = readLocalStateSnapshot();
  if (snapshot.inventory.length > 0) {
    state.inventory = snapshot.inventory;
  } else {
    state.inventory = clone(defaultInventory);
  }
  state.report = snapshot.report;
  state.photo = snapshot.photo;
}

function applyStatePayload(payload) {
  const inventory = Array.isArray(payload?.inventory)
    ? payload.inventory
    : clone(defaultInventory);
  state.inventory = sanitizeInventory(inventory);
  state.report = { ...defaultReport, ...(payload?.report || {}) };
  state.photo = payload?.photo ?? null;
}

function persistStateLocally() {
  writeStorage(STORAGE_KEYS.inventory, state.inventory);
  writeStorage(STORAGE_KEYS.report, state.report);
  writeStorage(STORAGE_KEYS.photo, state.photo);
}

function queuePersistState() {
  persistStateLocally();
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    pushStateToServer().catch((error) => {
      console.warn("Failed to sync state to backend", error);
    });
  }, PERSIST_DEBOUNCE_MS);
}

async function pushStateToServer() {
  const payload = serializeStateForTransport();
  const res = await fetch(API_ENDPOINTS.state, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`state sync failed: ${res.status} ${text}`);
  }
  return res.json();
}

function serializeStateForTransport() {
  return {
    inventory: state.inventory,
    report: state.report,
    photo: state.photo,
  };
}

function clone(value) {
  return value.map((item) => ({ ...item }));
}

function readLocalStateSnapshot() {
  const storedInventoryRaw = readStorage(STORAGE_KEYS.inventory);
  const inventory = sanitizeInventoryOptional(
    Array.isArray(storedInventoryRaw) ? storedInventoryRaw : [],
  );
  const storedReport = readStorage(STORAGE_KEYS.report);
  const report = { ...defaultReport, ...(storedReport || {}) };
  const photo = readStorage(STORAGE_KEYS.photo);
  return { inventory, report, photo };
}

function buildDefaultInventory() {
  const createItem = (name, ideal = 0) => ({
    id: generateId(),
    name,
    ideal,
    current: ideal,
  });

  const baseItems = [
    createItem("サラダ油（8個入り）", 8),
    createItem("出汁セット", 3),
    createItem("タコ（1袋）", 2),
  ];

  const additionalNames = [
    "そーす",
    "まよ",
    "天かす",
    "ガスボンベ（◯本）",
    "かつお",
    "ふくろ",
    "粉",
    "はし",
    "タコせん",
    "油",
    "しょうゆ",
    "青のり",
    "卵",
    "長いも",
    "たこ",
    "白だし",
    "紅生姜",
    "出汁液",
  ];

  const additionalItems = additionalNames.map((name) => createItem(name));

  return [...baseItems, ...additionalItems];
}

function resolveBackendOrigin() {
  if (typeof window === "undefined") {
    return "http://localhost:8000";
  }

  const { protocol, hostname, port } = window.location;

  // When opening the prototype directly via file://, default to local backend.
  if (protocol === "file:" || !hostname) {
    return "http://localhost:8000";
  }

  // when frontend is running on a different port (e.g. 8001), force backend 8000
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}//${hostname}:8000`;
  }

  // default: same origin (useful when deployed behind reverse proxy)
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}
