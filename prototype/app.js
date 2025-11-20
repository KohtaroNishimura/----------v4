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
let persistTimer = null;

const defaultInventory = [
  {
    id: generateId(),
    name: "サラダ油（8個入り）",
    ideal: 8,
    current: 8,
  },
  { id: generateId(), name: "出汁セット", ideal: 3, current: 3 },
  { id: generateId(), name: "タコ（1袋）", ideal: 2, current: 2 },
];

const defaultReport = {
  loss: "0",
  setCount: "0",
  operationHours: "0",
  sales: "0",
  insights: "",
};

const state = {
  inventory: [],
  report: { ...defaultReport },
  photo: null,
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
  }

  elements.copyButton?.addEventListener("click", copyMessageToClipboard);
}

function renderInventoryRows() {
  if (!elements.inventoryBody) return;
  elements.inventoryBody.innerHTML = "";

  state.inventory.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.dataset.id = item.id;

    const nameTd = document.createElement("td");
    nameTd.dataset.label = "材料名";
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
    const idealInput = document.createElement("input");
    idealInput.type = "number";
    idealInput.min = "0";
    idealInput.step = "1";
    idealInput.inputMode = "numeric";
    idealInput.value = item.ideal ?? 0;
    idealInput.addEventListener("input", () => {
      updateInventoryItem(
        item.id,
        {
          ideal: parseNumber(idealInput.value, 0),
        },
        tr,
      );
    });
    idealTd.appendChild(idealInput);

    const currentTd = document.createElement("td");
    currentTd.dataset.label = "現在庫";
    const currentInput = document.createElement("input");
    currentInput.type = "number";
    currentInput.min = "0";
    currentInput.step = "1";
    currentInput.inputMode = "numeric";
    currentInput.value = item.current ?? 0;
    currentInput.addEventListener("input", () => {
      updateInventoryItem(
        item.id,
        {
          current: parseNumber(currentInput.value, 0),
        },
        tr,
      );
    });
    currentTd.appendChild(currentInput);

    const shortageTd = document.createElement("td");
    shortageTd.dataset.label = "不足";
    shortageTd.dataset.role = "shortage";
    shortageTd.textContent = formatShortage(item);

    const actionsTd = document.createElement("td");
    actionsTd.dataset.label = "操作";
    actionsTd.classList.add("row-actions");
    const upButton = createActionButton("↑", "上に移動", () =>
      moveInventoryItem(item.id, -1),
    );
    upButton.disabled = index === 0;
    const downButton = createActionButton("↓", "下に移動", () =>
      moveInventoryItem(item.id, 1),
    );
    downButton.disabled = index === state.inventory.length - 1;
    const deleteButton = createActionButton("削除", "行を削除", () =>
      removeInventoryItem(item.id),
    );
    actionsTd.append(upButton, downButton, deleteButton);

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
  shortageCell.textContent = item ? formatShortage(item) : "";
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

function moveInventoryItem(id, direction) {
  const index = state.inventory.findIndex((item) => item.id === id);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.inventory.length) return;
  const updated = [...state.inventory];
  const [moved] = updated.splice(index, 1);
  updated.splice(targetIndex, 0, moved);
  state.inventory = updated;
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
}

function updateLinePreview() {
  if (!elements.linePreview) return;
  const message = buildLineMessage();
  elements.linePreview.value = message;
}

function buildLineMessage() {
  const shortageItems = state.inventory
    .map((item) => ({
      ...item,
      shortage: Math.max(0, (item.ideal ?? 0) - (item.current ?? 0)),
    }))
    .filter((item) => item.shortage > 0);

  const lines = [];

  if (shortageItems.length) {
    lines.push("【在庫不足（推奨発注数）】");
    shortageItems.forEach((item) => {
      lines.push(
        `・${item.name}: 理想${item.ideal} / 現在${item.current} → 不足${item.shortage}`,
      );
    });
  } else {
    lines.push("【在庫不足】なし（理想在庫クリア）");
  }

  lines.push("", "【日報テンプレ】");
  lines.push(`${state.report.loss ?? 0} ←処分したたこ焼き（ロス）`);
  lines.push(`${state.report.setCount ?? 0} ←セット数`);
  lines.push(`${state.report.operationHours ?? 0} ←営業時間（生産性）`);
  const salesValue = formatCurrency(state.report.sales);
  lines.push(`${salesValue} ←売上`);
  lines.push(
    `所感・困りごと: ${state.report.insights?.trim() || "特記事項なし"}`,
  );

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
  const shortage = Math.max(0, (item.ideal ?? 0) - (item.current ?? 0));
  return shortage > 0 ? `不足 ${shortage}` : "OK";
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value) {
  const numeric = parseNumber(value, 0);
  return numeric.toLocaleString("ja-JP");
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

function normalizeCount(value) {
  return Math.max(0, parseNumber(value, 0));
}

function createActionButton(label, title, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", handler);
  return button;
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
  const storedInventory = readStorage(STORAGE_KEYS.inventory);
  state.inventory = sanitizeInventory(
    Array.isArray(storedInventory) ? storedInventory : clone(defaultInventory),
  );
  const storedReport = readStorage(STORAGE_KEYS.report);
  state.report = { ...defaultReport, ...(storedReport || {}) };
  state.photo = readStorage(STORAGE_KEYS.photo);
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

function resolveBackendOrigin() {
  if (typeof window === "undefined") {
    return "http://localhost:8000";
  }

  const { protocol, hostname, port } = window.location;

  // when frontend is running on a different port (e.g. 8001), force backend 8000
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}//${hostname}:8000`;
  }

  // default: same origin (useful when deployed behind reverse proxy)
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}
