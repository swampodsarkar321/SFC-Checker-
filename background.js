// Missed Reply Tracker — badge, notifications, options, dashboard

const AUTO_SCAN_ALARM = "mrt-my-tickets-scan";
const DAILY_SUMMARY_ALARM = "mrt-daily-summary";
const NOTIFICATION_HISTORY_LIMIT = 500;
const notificationsInFlight = new Set();
const FIREBASE_API_KEY = "AIzaSyAsCuNWtsIEX2mvXxpdVWvWS-J8jwFH6hM";
const DEFAULT_DATABASE_URL = "https://steadfast-leaderbord-default-rtdb.asia-southeast1.firebasedatabase.app";
const FIREBASE_INTERNAL_KEYS = new Set(["firebaseAuth", "firebaseSyncMeta", "firebaseSyncStatus"]);
let firebaseSyncTimer = null;
let firebaseSyncPromise = null;
let firebaseSyncPending = false;

async function getFirebaseSettings() {
  return {
    enabled: true,
    databaseUrl: DEFAULT_DATABASE_URL
  };
}

async function getFirebaseToken() {
  const { firebaseAuth = null } = await chrome.storage.local.get("firebaseAuth");
  if (firebaseAuth?.idToken && firebaseAuth.expiresAt > Date.now() + 60_000) {
    return firebaseAuth.idToken;
  }

  const endpoint = firebaseAuth?.refreshToken
    ? `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`
    : `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: firebaseAuth?.refreshToken
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : { "Content-Type": "application/json" },
    body: firebaseAuth?.refreshToken
      ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: firebaseAuth.refreshToken })
      : JSON.stringify({ returnSecureToken: true })
  });
  const result = await response.json();
  if (!response.ok) {
    const firebaseError = result.error?.message || "Unknown error";
    if (firebaseError === "CONFIGURATION_NOT_FOUND") {
      throw new Error("Firebase Authentication is not enabled for this project. The project owner must enable Anonymous sign-in once in Firebase Console > Authentication > Sign-in method.");
    }
    throw new Error(`Firebase sign-in failed (${response.status}): ${firebaseError}`);
  }
  const expiresInSeconds = Number(result.expiresIn ?? result.expires_in);
  const session = {
    idToken: result.idToken || result.id_token,
    refreshToken: result.refreshToken || result.refresh_token || firebaseAuth?.refreshToken,
    localId: result.localId || result.user_id,
    expiresAt: Date.now() + expiresInSeconds * 1000
  };
  if (typeof session.idToken !== "string" || !session.idToken ||
      typeof session.refreshToken !== "string" || !session.refreshToken ||
      typeof session.localId !== "string" || !session.localId ||
      !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 ||
      !Number.isFinite(session.expiresAt)) {
    const availableFields = Object.keys(result || {}).join(", ") || "none";
    throw new Error(`Firebase sign-in returned an incomplete session (response fields: ${availableFields}). Check Firebase Authentication settings and extension logs.`);
  }
  await chrome.storage.local.set({ firebaseAuth: session });
  return session.idToken;
}

async function firebaseRequest(databaseUrl, path, token, options = {}) {
  const url = new URL(`${databaseUrl}/${path}.json`);
  url.searchParams.set("auth", token);
  const response = await fetch(url.toString(), {
    ...options,
    headers: { ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok) {
    const firebaseError = result?.error || "Unknown error";
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Firebase Realtime Database rejected access (${response.status}). In Firebase Console, confirm Anonymous Authentication is enabled and publish the Realtime Database Rules from README.md in the same project as this database. Details: ${firebaseError}`
      );
    }
    throw new Error(`Firebase database request failed (${response.status}): ${firebaseError}`);
  }
  return result;
}

function getLeaderboardEntry(data) {
  const settings = data.settings || {};
  const name = String(settings.agentName || "").trim();
  if (!name) return null;

  const tickets = data.tickets && typeof data.tickets === "object"
    ? Object.values(data.tickets).filter((ticket) => ticket && typeof ticket === "object")
    : [];
  const assignedTickets = settings.onlyMine
    ? tickets.filter((ticket) => !ticket.assignedTo ||
        String(ticket.assignedTo).toLowerCase().includes(name.toLowerCase()))
    : tickets;
  const ratingValue = data.ratingSummary?.myRating;
  const rating = ratingValue == null || ratingValue === "" ? null : Number(ratingValue);
  const satisfactionValue = data.ratingSummary?.satisfiedPct;
  const satisfaction = satisfactionValue == null || satisfactionValue === "" ? null : Number(satisfactionValue);

  return {
    agentName: name,
    rating: Number.isFinite(rating) ? rating : null,
    satisfactionPct: Number.isFinite(satisfaction) ? satisfaction : null,
    totalTickets: assignedTickets.length,
    updatedAt: Date.now()
  };
}

async function setFirebaseSyncStatus(status, message = "") {
  await chrome.storage.local.set({
    firebaseSyncStatus: { status, message, updatedAt: Date.now() }
  });
}

async function syncFirebaseOnce() {
  const config = await getFirebaseSettings();
  if (!config.enabled) {
    await setFirebaseSyncStatus("disabled");
    return;
  }

  await setFirebaseSyncStatus("syncing");
  const token = await getFirebaseToken();
  const { firebaseAuth, firebaseSyncMeta, ...localData } = await chrome.storage.local.get(null);
  const privateData = Object.fromEntries(
    Object.entries(localData).filter(([key]) => !FIREBASE_INTERNAL_KEYS.has(key))
  );
  const remoteData = await firebaseRequest(config.databaseUrl, `users/${firebaseAuth.localId}/data`, token);
  if (remoteData != null && (typeof remoteData !== "object" || Array.isArray(remoteData))) {
    throw new Error("Firebase user data has an unexpected format; local data was not overwritten.");
  }

  const hasSyncedAccount = firebaseSyncMeta?.uid === firebaseAuth.localId;
  const dataToSave = hasSyncedAccount
    ? privateData
    : { ...(remoteData || {}), ...privateData };
  if (!hasSyncedAccount && JSON.stringify(dataToSave) !== JSON.stringify(privateData)) {
    await chrome.storage.local.set(dataToSave);
  }

  await firebaseRequest(config.databaseUrl, `users/${firebaseAuth.localId}/data`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dataToSave)
  });
  const leaderboardEntry = getLeaderboardEntry(dataToSave);
  if (leaderboardEntry) {
    await firebaseRequest(config.databaseUrl, `leaderboard/${firebaseAuth.localId}`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leaderboardEntry)
    });
  } else {
    await firebaseRequest(config.databaseUrl, `leaderboard/${firebaseAuth.localId}`, token, {
      method: "DELETE"
    });
  }
  await chrome.storage.local.set({ firebaseSyncMeta: { uid: firebaseAuth.localId } });
  await setFirebaseSyncStatus("synced");
}

function scheduleFirebaseSync() {
  clearTimeout(firebaseSyncTimer);
  firebaseSyncTimer = setTimeout(() => {
    firebaseSyncTimer = null;
    if (firebaseSyncPromise) {
      firebaseSyncPending = true;
      return;
    }
    firebaseSyncPromise = (async () => {
      do {
        firebaseSyncPending = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          await syncFirebaseOnce();
        } catch (error) {
          console.error("[MRT] Firebase sync failed:", error);
          await setFirebaseSyncStatus("error", error.message);
        }
      } while (firebaseSyncPending);
    })().finally(() => {
      firebaseSyncPromise = null;
    });
  }, 1500);
}

function dedupeLeaderboardEntries(entries) {
  const entriesByAgent = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.agentName !== "string") continue;
    const agentName = entry.agentName.trim().replace(/\s+/g, " ");
    if (!agentName) continue;
    const key = agentName.toLowerCase();
    const existing = entriesByAgent.get(key);
    if (!existing || (Number(entry.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) {
      entriesByAgent.set(key, { ...entry, agentName });
    }
  }
  return [...entriesByAgent.values()];
}

async function getFirebaseLeaderboard() {
  const config = await getFirebaseSettings();
  if (!config.enabled) throw new Error("Enable Firebase sync in Settings to view the leaderboard.");
  const token = await getFirebaseToken();
  const result = await firebaseRequest(config.databaseUrl, "leaderboard", token);
  if (result == null) return [];
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Firebase leaderboard has an unexpected format.");
  }
  return dedupeLeaderboardEntries(Object.values(result));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((key) => !FIREBASE_INTERNAL_KEYS.has(key))) {
    scheduleFirebaseSync();
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    scheduleFirebaseSync();
    return;
  }

  syncFirebaseOnce()
    .catch(async (error) => {
      console.error("[MRT] Initial Firebase sync failed:", error);
      await setFirebaseSyncStatus("error", error.message);
    })
    .finally(() => {
      chrome.tabs.create({ url: `${chrome.runtime.getURL("dashboard.html")}?welcome=1` });
    });
});
chrome.runtime.onStartup.addListener(scheduleFirebaseSync);

function isWithinQuietHours(start, end, now = new Date()) {
  const toMinutes = (value) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes == null || endMinutes == null || startMinutes === endMinutes) return false;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

async function showMrtNotification(msg) {
  try {
    const { settings = {}, notificationHistory = [] } = await chrome.storage.local.get(["settings", "notificationHistory"]);
    const category = msg.category || "missed";
    if (category !== "daily-summary" && settings.notificationMode === "missed-only" &&
        category !== "missed" && category !== "pending" && category !== "rating") return;
    if (category !== "daily-summary" && settings.notificationMode === "missed-and-customer" && category === "late") return;
    if (settings.quietHoursEnabled === true &&
        isWithinQuietHours(settings.quietHoursStart || "22:00", settings.quietHoursEnd || "08:00")) return;

    const eventKey = String(msg.eventKey || "");
    const history = Array.isArray(notificationHistory) ? notificationHistory : [];
    if (eventKey && (history.includes(eventKey) || notificationsInFlight.has(eventKey))) return;
    if (eventKey) notificationsInFlight.add(eventKey);

    const notificationId = eventKey
      ? `mrt-${Array.from(eventKey).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0).toString(36)}`
      : "";
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icon.png",
      title: msg.title || "Missed Reply Alert",
      message: msg.text || "New missed reply detected"
    });
    if (eventKey) {
      history.push(eventKey);
      await chrome.storage.local.set({ notificationHistory: history.slice(-NOTIFICATION_HISTORY_LIMIT) });
    }
    // Persist a unified notification inbox entry (category-wise) for the dashboard.
    try {
      const { notifications = [] } = await chrome.storage.local.get("notifications");
      const list = Array.isArray(notifications) ? notifications : [];
      if (!eventKey || !list.some((n) => n.eventKey === eventKey)) {
        list.unshift({
          eventKey: eventKey || "",
          category,
          title: msg.title || "",
          text: msg.text || "",
          at: Date.now(),
          read: false
        });
        await chrome.storage.local.set({ notifications: list.slice(0, NOTIFICATION_HISTORY_LIMIT) });
      }
    } catch (e) {}
  } catch (error) {
    console.error("[MRT] Could not show notification:", error);
  } finally {
    if (msg.eventKey) notificationsInFlight.delete(String(msg.eventKey));
  }
}

async function syncAutoScanAlarm() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (settings.enabled !== false && settings.autoMyTicketsScan === true) {
    await chrome.alarms.create(AUTO_SCAN_ALARM, { periodInMinutes: 5 });
  } else {
    await chrome.alarms.clear(AUTO_SCAN_ALARM);
  }
}

function getNextDailySummaryTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  const next = new Date();
  next.setHours(match ? Number(match[1]) : 9, match ? Number(match[2]) : 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function syncDailySummaryAlarm() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (settings.enabled !== false && settings.dailySummaryEnabled !== false) {
    await chrome.alarms.create(DAILY_SUMMARY_ALARM, {
      when: getNextDailySummaryTime(settings.dailySummaryTime || "09:00")
    });
  } else {
    await chrome.alarms.clear(DAILY_SUMMARY_ALARM);
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function sendDailySummary() {
  const { settings = {}, tickets = {} } = await chrome.storage.local.get(["settings", "tickets"]);
  if (settings.enabled === false || settings.dailySummaryEnabled === false) return;

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const todayTickets = Object.values(tickets).filter((ticket) => {
    if (!ticket || typeof ticket !== "object") return false;
    if (settings.onlyMine !== true || !settings.agentName) return true;
    const assignedTo = String(ticket.assignedTo || "").toLowerCase();
    return !assignedTo || assignedTo.includes(String(settings.agentName).toLowerCase());
  });
  const customerReplies = todayTickets.filter((ticket) =>
    Number(ticket.lastCustomerAt) >= startOfDay.getTime() && Number(ticket.lastCustomerAt) <= now.getTime()
  ).length;
  const agentReplies = todayTickets.filter((ticket) =>
    Number(ticket.lastAgentAt) >= startOfDay.getTime() && Number(ticket.lastAgentAt) <= now.getTime()
  );
  const waiting = todayTickets.filter((ticket) =>
    Number(ticket.lastCustomerAt) > 0 &&
    !(Number(ticket.lastAgentAt) >= Number(ticket.lastCustomerAt))
  ).length;
  const responseTimes = agentReplies
    .map((ticket) => Number(ticket.lastResponseDelayMs))
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  const averageResponse = responseTimes.length
    ? formatResponseDuration(responseTimes.reduce((sum, delay) => sum + delay, 0) / responseTimes.length)
    : "not recorded";
  const text = `Today: ${customerReplies} ticket${customerReplies === 1 ? "" : "s"} with customer replies, ${agentReplies.length} with agent replies; ${waiting} ticket${waiting === 1 ? "" : "s"} still awaiting a reply. Average recorded response: ${averageResponse}.`;

  await showMrtNotification({
    category: "daily-summary",
    eventKey: `daily-summary:${localDateKey(now)}`,
    title: "Daily ticket summary",
    text
  });
}

function formatResponseDuration(milliseconds) {
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

chrome.runtime.onInstalled.addListener(() =>
  Promise.all([syncAutoScanAlarm(), syncDailySummaryAlarm()])
    .catch((error) => console.error("[MRT] alarm setup failed:", error))
);

chrome.runtime.onStartup.addListener(() =>
  Promise.all([syncAutoScanAlarm(), syncDailySummaryAlarm()])
    .catch((error) => console.error("[MRT] alarm setup failed:", error))
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    return Promise.all([syncAutoScanAlarm(), syncDailySummaryAlarm()])
      .catch((error) => console.error("[MRT] alarm update failed:", error));
  }
});

async function requestAutoMyTicketsScan(tabId, attempts = 30, force = false) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "MRT_AUTO_MY_TICKETS_SCAN", force });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        console.warn("[MRT] Could not start scheduled My tickets scan:", error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DAILY_SUMMARY_ALARM) {
    try {
      await sendDailySummary();
    } catch (error) {
      console.error("[MRT] Daily summary could not be sent:", error);
    } finally {
      await syncDailySummaryAlarm().catch((error) => console.error("[MRT] Daily summary alarm could not be rescheduled:", error));
    }
    return;
  }
  if (alarm.name !== AUTO_SCAN_ALARM) return;

  try {
    const { settings = {}, deepScan } = await chrome.storage.local.get(["settings", "deepScan"]);
    const scanLastUpdate = Number(deepScan?.updatedAt || deepScan?.startedAt) || 0;
    const stale = !!deepScan?.active &&
      (!scanLastUpdate || Date.now() - scanLastUpdate > 15 * 60 * 1000);
    if (settings.enabled === false || settings.autoMyTicketsScan !== true || (deepScan?.active && !stale)) return;
    if (stale) await chrome.storage.local.set({
      deepScan: { ...deepScan, active: false, queue: [], updatedAt: Date.now() }
    });

    const supportUrl = "https://dash.packzy.com/admin/support";
    const tabs = await chrome.tabs.query({ url: `${supportUrl}*` });
    if (tabs.length) {
      await requestAutoMyTicketsScan(tabs[0].id);
      return;
    }

    const tab = await chrome.tabs.create({ url: supportUrl, active: false });
    await requestAutoMyTicketsScan(tab.id);
  } catch (error) {
    console.error("[MRT] Scheduled My tickets scan could not be dispatched:", error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/dash\.packzy\.com\//i.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "MRT_TOGGLE_PANEL" });
    return;
  } catch (error) {
    console.info("[MRT] Injecting tracker into the current Packzy tab:", error);
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await chrome.tabs.sendMessage(tab.id, { type: "MRT_TOGGLE_PANEL" });
  } catch (injectionError) {
    console.error("[MRT] Could not start tracker in Packzy tab:", injectionError);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "MRT_BADGE" && sender.tab?.id != null) {
    const n = Number(msg.count) || 0;
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#b3261e" });
    sendResponse({ ok: true });
  }

  if (msg?.type === "MRT_NOTIFY") {
    showMrtNotification(msg);
    sendResponse({ ok: true });
  }

  if (msg?.type === "MRT_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  if (msg?.type === "MRT_TRIGGER_AUTO_SCAN") {
    (async () => {
      try {
        const supportUrl = "https://dash.packzy.com/admin/support";
        let tabs = await chrome.tabs.query({ url: `${supportUrl}*` });
        if (!tabs.length) {
          const tab = await chrome.tabs.create({ url: supportUrl, active: false });
          tabs = [tab];
        }
        await requestAutoMyTicketsScan(tabs[0].id, 20, msg.force === true);
      } catch (error) {
        console.error("[MRT] Trigger auto scan failed:", error);
      }
    })();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "MRT_FIREBASE_SYNC_NOW") {
    syncFirebaseOnce()
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        console.error("[MRT] Firebase sync failed:", error);
        await setFirebaseSyncStatus("error", error.message);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (msg?.type === "MRT_FIREBASE_GET_LEADERBOARD") {
    getFirebaseLeaderboard()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => {
        console.error("[MRT] Firebase leaderboard request failed:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (msg?.type === "MRT_OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
  }

  return false;
});
