const DEFAULTS = {
  agentName: "",
  onlyMine: true,
  enabled: true,
  soundOn: true,
  replyWarningHours: 12,
  pendingAlertMinutes: 10,
  highPriorityAlertMinutes: 5,
  urgentPriorityAlertMinutes: 1,
  dailySummaryEnabled: true,
  dailySummaryTime: "09:00",
  notificationMode: "all",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  autoScanSec: 90,
  urlPattern: "dash\\.packzy\\.com/admin/support",
};

async function load() {
  const [{ settings: localSettings = {} }, { settings: syncSettings = {} }] = await Promise.all([
    chrome.storage.local.get("settings"),
    chrome.storage.sync.get("settings")
  ]);
  const mergedSettings = {
    ...syncSettings,
    ...localSettings,
    agentName: localSettings.agentName || syncSettings.agentName || ""
  };
  const hadLegacyAdminId = Object.prototype.hasOwnProperty.call(mergedSettings, "adminId");
  delete mergedSettings.adminId;
  const s = { ...DEFAULTS, ...mergedSettings };
  if (s.agentName || hadLegacyAdminId) {
    await chrome.storage.local.set({ settings: mergedSettings });
  }
  if (hadLegacyAdminId) {
    const cleanedSyncSettings = { ...syncSettings };
    delete cleanedSyncSettings.adminId;
    await chrome.storage.sync.set({ settings: cleanedSyncSettings });
  }

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ""; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

  setVal("agentName", s.agentName);
  setVal("urlPattern", s.urlPattern);
  setVal("replyWarningHours", s.replyWarningHours);
  setVal("pendingAlertMinutes", s.pendingAlertMinutes);
  setVal("highPriorityAlertMinutes", s.highPriorityAlertMinutes);
  setVal("urgentPriorityAlertMinutes", s.urgentPriorityAlertMinutes);
  setVal("dailySummaryTime", s.dailySummaryTime);
  setVal("autoScanSec", s.autoScanSec);
  setVal("notificationMode", s.notificationMode);
  setVal("quietHoursStart", s.quietHoursStart);
  setVal("quietHoursEnd", s.quietHoursEnd);
  setChk("onlyMine", s.onlyMine);
  setChk("enabled", s.enabled);
  setChk("soundOn", s.soundOn);
  setChk("quietHoursEnabled", s.quietHoursEnabled);
  setChk("dailySummaryEnabled", s.dailySummaryEnabled);
  updateFirebaseSyncStatus();
}

async function updateFirebaseSyncStatus() {
  const { firebaseSyncStatus } = await chrome.storage.local.get("firebaseSyncStatus");
  const statusEl = document.getElementById("firebaseSyncStatus");
  if (!statusEl) return;
  if (firebaseSyncStatus?.status === "error") {
    statusEl.textContent = `Sync error: ${firebaseSyncStatus.message || "See extension logs."}`;
  } else if (firebaseSyncStatus?.status === "syncing") {
    statusEl.textContent = "Syncing…";
  } else if (firebaseSyncStatus?.status === "synced") {
    statusEl.textContent = `Synced ${new Date(firebaseSyncStatus.updatedAt).toLocaleTimeString()}`;
  } else if (firebaseSyncStatus?.status === "disabled") {
    statusEl.textContent = "Firebase sync is disabled.";
  } else {
    statusEl.textContent = "Not synced yet";
  }
}

const num = (id, def) => {
  const v = parseInt(document.getElementById(id)?.value, 10);
  return Number.isFinite(v) ? v : def;
};

document.getElementById("save").addEventListener("click", async () => {
  const warningInput = document.getElementById("replyWarningHours");
  const pendingInput = document.getElementById("pendingAlertMinutes");
  const highPriorityInput = document.getElementById("highPriorityAlertMinutes");
  const urgentPriorityInput = document.getElementById("urgentPriorityAlertMinutes");
  if (!warningInput.reportValidity() || !pendingInput.reportValidity() ||
      !highPriorityInput.reportValidity() || !urgentPriorityInput.reportValidity()) return;
  const quietHoursStart = document.getElementById("quietHoursStart").value;
  const quietHoursEnd = document.getElementById("quietHoursEnd").value;
  if (document.getElementById("quietHoursEnabled").checked && quietHoursStart === quietHoursEnd) {
    alert("Quiet hours start and end times must differ.");
    return;
  }
  const agentName = document.getElementById("agentName").value.trim();
  const s = {
    agentName,
    urlPattern: document.getElementById("urlPattern").value.trim() || DEFAULTS.urlPattern,
    autoScanSec: Math.max(30, num("autoScanSec", 90)),
    replyWarningHours: Math.max(1, Math.min(168, num("replyWarningHours", DEFAULTS.replyWarningHours))),
    pendingAlertMinutes: Math.max(1, Math.min(1440, num("pendingAlertMinutes", DEFAULTS.pendingAlertMinutes))),
    highPriorityAlertMinutes: Math.max(1, Math.min(1440, num("highPriorityAlertMinutes", DEFAULTS.highPriorityAlertMinutes))),
    urgentPriorityAlertMinutes: Math.max(1, Math.min(1440, num("urgentPriorityAlertMinutes", DEFAULTS.urgentPriorityAlertMinutes))),
    dailySummaryEnabled: document.getElementById("dailySummaryEnabled").checked,
    dailySummaryTime: document.getElementById("dailySummaryTime").value || DEFAULTS.dailySummaryTime,
    notificationMode: ["missed-only", "missed-and-customer"].includes(document.getElementById("notificationMode").value)
      ? document.getElementById("notificationMode").value
      : "all",
    quietHoursEnabled: document.getElementById("quietHoursEnabled").checked,
    quietHoursStart: quietHoursStart || DEFAULTS.quietHoursStart,
    quietHoursEnd: quietHoursEnd || DEFAULTS.quietHoursEnd,
    onlyMine: document.getElementById("onlyMine").checked,
    enabled: document.getElementById("enabled").checked,
    soundOn: document.getElementById("soundOn").checked
  };

  const [{ settings: localSettings = {} }, { settings: syncSettings = {} }] = await Promise.all([
    chrome.storage.local.get("settings"),
    chrome.storage.sync.get("settings")
  ]);
  const mergedSettings = { ...syncSettings, ...localSettings, ...s };
  delete mergedSettings.adminId;
  mergedSettings.autoMyTicketsScan = localSettings.autoMyTicketsScan === true ||
    syncSettings.autoMyTicketsScan === true;
  await chrome.storage.local.set({ settings: mergedSettings });
  await chrome.storage.sync.set({ settings: mergedSettings });

  const sv = document.getElementById("saved");
  sv.style.display = "inline";
  setTimeout(() => (sv.style.display = "none"), 1500);
});

document.getElementById("firebaseSyncNow").addEventListener("click", async () => {
  const statusEl = document.getElementById("firebaseSyncStatus");
  statusEl.textContent = "Syncing…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "MRT_FIREBASE_SYNC_NOW" });
    if (!response?.ok) throw new Error(response?.error || "Could not sync Firebase data.");
    await updateFirebaseSyncStatus();
  } catch (error) {
    statusEl.textContent = `Sync error: ${error.message || error}`;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.firebaseSyncStatus) updateFirebaseSyncStatus();
});

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove([
    "tickets",
    "deepScan",
    "lastProgress",
    "lastDeepScanAt",
    "lastAutoMyTicketsScanAt",
    "lastScanSummary",
    "ratingChanges",
    "notifications",
    "notificationHistory"
  ]);
  const sv = document.getElementById("saved");
  sv.textContent = "🗑 Data cleared!";
  sv.style.display = "inline";
  setTimeout(() => { sv.style.display = "none"; sv.textContent = "✅ Saved!"; }, 2000);
});

document.getElementById("backup").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  delete data.firebaseAuth;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mrt-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("restoreBtn").addEventListener("click", () => {
  document.getElementById("restoreFile").click();
});

document.getElementById("restoreFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(data);
    if (data.settings) await chrome.storage.sync.set({ settings: data.settings });
    const sv = document.getElementById("saved");
    sv.textContent = "✅ Restored!";
    sv.style.display = "inline";
    setTimeout(() => { sv.style.display = "none"; sv.textContent = "✅ Saved!"; }, 2000);
    load();
  } catch (err) {
    alert("Restore failed: " + (err?.message || err));
  }
  e.target.value = "";
});
