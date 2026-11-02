// ============================================================
// Missed Reply Tracker v2 — packzy.com panel er jonno
// ------------------------------------------------------------
// Panel:  https://dash.packzy.com/admin/support
// Ticket: https://dash.packzy.com/admin/support?ticket_id=ID
//
// Rule: latest customer message-er por agent reply na thakle = MISSED.
//       reply dite 12 ghontar beshi lagle late-response warning dekhay.
//
// Verified selectors (live test kora):
//   Row        : button.ticket-item
//   Row ID     : .ticket-item__id        (#3580117)
//   Row name   : .ticket-item__name
//   Row time   : time[datetime]          (exact ISO UTC)
//   Row preview: .ticket-item__preview
//   Row unread : .ticket-item__unread
//   Load more  : button.load-more__button ("Load older tickets")
//   Message    : article.msg
//     customer : .msg--inbound
//     agent    : .msg--outbound
//     text     : .msg__text
//     time     : time[datetime]
//   Facts      : .fact > .fact__label / .fact__value  (Assigned, Category)
//   Scope pills: .scope-pill  (Mine / Unassigned / Assigned / Hub / All)
// ============================================================
(() => {
  if (window.__MRT_LOADED__) return;
  window.__MRT_LOADED__ = true;

  // ---------------- settings ----------------
  const DEFAULTS = {
    enabled: true,
    autoMyTicketsScan: false,
    agentName: "",
    onlyMine: true,
    replyWarningHours: 12,
    pendingAlertMinutes: 10,
    highPriorityAlertMinutes: 5,
    urgentPriorityAlertMinutes: 1,
    deepScanDelay: 1800,
    autoScanSec: 90,
    urlPattern: "dash\\.packzy\\.com/admin/support",
    soundOn: true
  };

  let settings = { ...DEFAULTS };
  let tickets = {};                       // id -> ticket state
  let customerReplies = [];
  let deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
  let progressText = "";
  let panel = null;
  let fab = null;
  let panelOpen = false;                  // saved per tab so another Packzy tab stays independent
  let cancelDeepScan = false;
  let autoMyTicketsScanRunning = false;
  let quickUnreadScanPromise = null;
  let bootReady = false;
  let lastUrl = location.href;
  const scanOwnerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scanStaleMs = 15 * 60 * 1000;
  let scanStartedAt = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const getReplyWarningHours = () => Math.max(1, Math.min(168, Number(settings.replyWarningHours) || 12));
  const getPendingAlertMinutes = (priority = "") => {
    const level = String(priority || "").toLowerCase();
    const configured = level === "urgent"
      ? settings.urgentPriorityAlertMinutes
      : level === "high" ? settings.highPriorityAlertMinutes : settings.pendingAlertMinutes;
    const fallback = level === "urgent" ? 1 : level === "high" ? 5 : 10;
    return Math.max(1, Math.min(1440, Number(configured) || fallback));
  };
  const icon = (name) => {
    const paths = {
      tracker: '<path d="M12 3a7 7 0 0 0-7 7v4l-2 3h18l-2-3v-4a7 7 0 0 0-7-7Zm-3 17a3 3 0 0 0 6 0"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 11.6-2L20 12M4 12l2.9 5a7 7 0 0 0 11.6-2"/>',
      scan: '<path d="M4 7V4h3m10 0h3v3M4 17v3h3m10 0h3v-3"/><path d="M7 12h10"/>',
      copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
      file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 14h8m-8 4h8"/>',
      dashboard: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
      open: '<path d="M14 4h6v6m-11 5L20 4"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      alert: '<path d="m12 3 9 17H3l9-17Z"/><path d="M12 9v5m0 3h.01"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      moon: '<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
      message: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.1.9-1.6 2.8-1.4-.6a8 8 0 0 1-1.5.9l-.2 1.5h-3.2l-.2-1.5a8 8 0 0 1-1.5-.9l-1.4.6L8 16l1.1-.9A8 8 0 0 1 9 13.4l-1.4-.8 1.6-2.8 1.5.5a8 8 0 0 1 1.5-.8l.2-1.5h3.2l.2 1.5a8 8 0 0 1 1.5.8l1.4-.5 1.6 2.8-1.1.8c.1.6.1 1.1.2 1.6Z"/>',
      check: '<path d="m5 12 4 4L19 6"/>'
    };
    return `<svg class="mrt-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  };
  const parseTimeStr = (txt) => {
  const m = (txt || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const d = new Date();
  d.setHours(h, mm, 0, 0);
  if (d.getTime() > Date.now() + 5 * 60000) d.setDate(d.getDate() - 1);
  return d.getTime();
};
const normalizeIso = (iso) => {
    if (!iso) return null;
    const t = Date.parse(String(iso).replace(/(\.\d{3})\d+/, "$1"));
    return Number.isNaN(t) ? null : t;
  };
  const pillText = (el) => String(el?.textContent || "").replace(/[\d+]+/g, "").trim().toLowerCase();
  const openTicketId = () => new URLSearchParams(location.search).get("ticket_id");
  const panelUrl = () => location.origin + "/admin/support";
  const ticketUrl = (id) => panelUrl() + "?ticket_id=" + encodeURIComponent(id);

  const store = {
    get: (keys) => new Promise((res) => chrome.storage.local.get(keys, res)),
    set: (obj) => new Promise((res) => chrome.storage.local.set(obj, res))
  };

  function isPanel() {
    try { return new RegExp(settings.urlPattern, "i").test(location.href); }
    catch (e) { return true; }
  }

  // ---------------- list parsing ----------------
  function scanList() {
    const rows = [];
qsa(".ticket-item").forEach((btn) => {
  const id = (qs(".ticket-item__id", btn)?.textContent || "").replace("#", "").trim();
  if (!/^\d+$/.test(id)) return;
  const rowText = (btn.textContent || "").toLowerCase();
  if (/\b(closed|solved|resolved|archived)\b/.test(rowText)) return;
  rows.push({
        id,
        name: qs(".ticket-item__name", btn)?.textContent.trim() || "",
        lastActivityAt: normalizeIso(qs("time[datetime]", btn)?.getAttribute("datetime")),
        preview: (qs(".ticket-item__preview", btn)?.textContent || "").trim().slice(0, 140),
        unread: parseInt(qs(".ticket-item__unread", btn)?.textContent, 10) || 0,
        priority: (qs('[class*="priority-"]', btn)?.className || "").match(/priority-(\w+)/)?.[1]?.toLowerCase() || "",
        rowEl: btn
      });
    });
    return rows;
  }

  // ---------------- conversation parsing ----------------
function parseConversation() {
  const msgs = [];
  qsa(".msg").forEach((m) => {
    let inbound = m.classList.contains("msg--inbound") || /\binbound\b/i.test(m.className);
    let outbound = m.classList.contains("msg--outbound") || /\boutbound\b/i.test(m.className);
    if (!inbound && !outbound) {
      // fallback: check data attributes or child sender labels
      const dir = (m.getAttribute("data-direction") || m.getAttribute("data-side") || "").toLowerCase();
      if (dir === "in" || dir === "incoming" || dir === "customer") inbound = true;
      if (dir === "out" || dir === "outgoing" || dir === "agent" || dir === "admin") outbound = true;
    }
    if (!inbound && !outbound) return;
    let at = normalizeIso(qs("time[datetime]", m)?.getAttribute("datetime"));
    if (!at) {
      // fallback: parse time text
      const timeEl = qs(".msg__time, .msg__footer time, time", m);
      const parsed = parseTimeStr(timeEl?.textContent);
      if (parsed) at = parsed;
    }
    if (!at) return;
    msgs.push({
      at,
      sender: inbound ? "customer" : "agent",
      text: (qs(".msg__text", m)?.textContent || m.textContent || "").trim().slice(0, 160)
    });
  });
  msgs.sort((a, b) => a.at - b.at);
  return msgs;
}

function fact(label) {
  const el = qsa(".fact").find((f) => (qs(".fact__label", f)?.textContent || "").trim() === label);
  return el ? (qs(".fact__value", el)?.textContent || "").trim() : "";
}
const hasFact = (label) => qsa(".fact").some((f) => (qs(".fact__label", f)?.textContent || "").trim() === label);

function findAssignmentTime(agentName) {
  const name = String(agentName || "").trim().toLowerCase();
  if (!name) return null;
  const activityNodes = qsa(".msg, article, li, [class*='activity'], [class*='event'], [class*='timeline']");
  const matchingEvents = activityNodes.filter((el) => {
    const text = (qs(".msg__text", el)?.textContent || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return text.includes("assigned to this ticket") && text.includes(name);
  });
  let latest = null;
  for (const event of matchingEvents) {
    const timeEl = qs("time[datetime]", event);
    const timestamp = normalizeIso(timeEl?.getAttribute("datetime")) ||
      parseTimeStr(qs(".msg__time, .msg__footer time, time", event)?.textContent || event.textContent);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function isMyTicketsScopeActive() {
  return qsa(".scope-pill.scope-pill--on").some((el) =>
    ["my tickets", "mine", "my"].includes(pillText(el))
  );
}

async function saveDetectedAgentName(names) {
  const distinctNames = [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
  if (distinctNames.length !== 1 || distinctNames[0] === settings.agentName) return;
  settings = { ...settings, agentName: distinctNames[0] };
  await store.set({ settings });
  console.log("[MRT] Detected Packzy agent name:", distinctNames[0]);
}

  // khola ticket er nam (header theke) — list row na paile
  function openTicketName(tid) {
    const re = new RegExp("#" + tid + "\\s+([^\\n#]{2,40})");
    for (const c of qsa('[class*="chat-header"], [class*="ticket-head"], [class*="conversation-head"], header')) {
      const m = (c.textContent || "").match(re);
      if (m) return m[1].trim().split(/\s{2,}/)[0];
    }
    const m = (document.body.textContent || "").match(re);
    return m ? m[1].trim().split(/\s{2,}/)[0] : "";
  }

  // ---------------- state ----------------
function applyListRow(row) {
  const t = tickets[row.id] || { id: row.id };
  t.name = t.name || row.name;
  t.lastActivityAt = row.lastActivityAt || t.lastActivityAt;
  t.preview = row.preview || t.preview;
  t.unread = (row.unread != null ? row.unread : (t.unread || 0));
  t.priority = row.priority || t.priority || "";
  tickets[row.id] = t;
}

  function applyConversation(id, meta, msgs) {
    if (!msgs.length) return;
    const prev = tickets[id] || { id };
    const lastCust = [...msgs].reverse().find((m) => m.sender === "customer") || null;
    const lastAgent = [...msgs].reverse().find((m) => m.sender === "agent") || null;
    const answered = lastAgent && lastCust ? lastAgent.at >= lastCust.at : !!lastAgent;
    const lastCustomerBeforeAgent = lastAgent
      ? [...msgs].reverse().find((m) => m.sender === "customer" && m.at < lastAgent.at)
      : null;
    const responseDelayMs = lastCustomerBeforeAgent ? lastAgent.at - lastCustomerBeforeAgent.at : null;
    const replyWarningHours = getReplyWarningHours();
    const lateResponse = responseDelayMs != null && responseDelayMs > replyWarningHours * 3600000;
    const newCustomerReplies = prev.lastCustomerAt
      ? msgs.filter((m) => m.sender === "customer" && m.at > prev.lastCustomerAt &&
        !msgs.some((later) => later.sender === "agent" && later.at > m.at))
      : prev.autoNotifyInitialReply && lastCust && (!lastAgent || lastCust.at > lastAgent.at)
        ? [lastCust]
        : [];

    const prevAssigned = prev.assignedTo || "";
    const reassigned = meta.assignmentKnown === true && !!meta.assignedTo && meta.assignedTo !== prevAssigned && !!prevAssigned;
    const t = {
      ...prev,
      id,
      autoNotifyInitialReply: false,
      name: meta.name || prev.name || "",
      category: meta.category || prev.category || "",
      assignedTo: meta.assignmentKnown ? (meta.assignedTo || "") : (prev.assignedTo || ""),
      assignmentKnown: meta.assignmentKnown ?? prev.assignmentKnown ?? false,
      assignedAt: meta.assignmentAt ||
        (meta.assignmentKnown && meta.assignedTo && meta.assignedTo !== prevAssigned
          ? Date.now()
          : (prev.assignedAt || null)),
      reassignedAt: reassigned ? Date.now() : (prev.reassignedAt || null),
      lastCustomerAt: lastCust?.at ?? prev.lastCustomerAt ?? null,
      lastCustomerText: lastCust?.text || prev.lastCustomerText || "",
      lastAgentAt: lastAgent?.at ?? null,
      lastResponseDelayMs: responseDelayMs,
      lastResponseCustomerAt: lastCustomerBeforeAgent?.at ?? null,
      lateResponse: lateResponse || false,
      answered,
      resolvedForCustomerAt: lastCust && prev.resolvedForCustomerAt !== lastCust.at
        ? null
        : (prev.resolvedForCustomerAt || null),
      lastActivityAt: msgs[msgs.length - 1].at,
      preview: msgs[msgs.length - 1].text,
      source: "conversation",
      parsedAt: Date.now()
    };

    // Clear stale alert state when the ticket is answered or reassigned so a
    // future missed/late situation can notify again instead of being deduped.
    if (answered) {
      delete t.lastMissedAlertFor;
      delete t.lastLateAlertCustomerAt;
    }
    if (reassigned) {
      delete t.lastMissedAlertFor;
      delete t.lastLateAlertCustomerAt;
      t.missed = false;
    }

    for (const reply of newCustomerReplies) {
      if (customerReplies.some((event) => event.id === id && event.at === reply.at)) continue;
      customerReplies.unshift({ id, name: t.name || "Customer", text: reply.text, at: reply.at });
      if (customerReplies.length > 500) customerReplies.length = 500;
      try {
        chrome.runtime.sendMessage({
          type: "MRT_NOTIFY",
          category: "customer",
          eventKey: `customer:${id}:${reply.at}`,
          title: "New Customer Reply",
          text: `#${id} · ${t.name || "Customer"}: ${(reply.text || "").slice(0, 100)}`
        });
      } catch (e) {}
    }

    t.missed = t.answered === false && !!t.lastCustomerAt &&
      Date.now() - t.lastCustomerAt >= replyWarningHours * 3600000;

    if (lateResponse && prev.lastLateAlertCustomerAt !== lastCustomerBeforeAgent.at) {
      t.lastLateAlertCustomerAt = lastCustomerBeforeAgent.at;
      try {
        chrome.runtime.sendMessage({
          type: "MRT_NOTIFY",
          category: "late",
          eventKey: `late:${id}:${lastCustomerBeforeAgent.at}`,
          title: `Agent reply took over ${replyWarningHours} hours`,
          text: `#${id} · ${t.name || "customer"}: ${durationLabel(responseDelayMs)} after customer reply`
        });
      } catch (e) {}
    }
    tickets[id] = t;
  }

  function timeAgo(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    const days = Math.floor(hours / 24);
    return `${days} d ${hours % 24} h`;
  }

  function durationLabel(milliseconds) {
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  }

  function clearSnoozeIfNeeded(t) {
    if (!t.snoozeUntil) return;
    if (t.snoozeUntil <= Date.now()) { delete t.snoozeUntil; delete t.snoozedAt; return; }
    // customer notun message dile snooze auto clear
    if (t.snoozedAt && t.lastActivityAt && t.lastActivityAt > t.snoozedAt) {
      delete t.snoozeUntil; delete t.snoozedAt;
    }
  }

  function computeAlerts() {
    const now = Date.now();
    const replyWarningHours = getReplyWarningHours();
    const thresholdMs = replyWarningHours * 3600000;
    const missed = [], waiting = [], snoozed = [], lateResponses = [], pending = [];

    for (const t of Object.values(tickets)) {
      clearSnoozeIfNeeded(t);

      if (settings.onlyMine && settings.agentName) {
        const a = (t.assignedTo || "").toLowerCase();
        if ((a && !a.includes(settings.agentName.toLowerCase())) || (!a && t.assignmentKnown)) continue;
      }

      const responseDelayMs = Number(t.lastResponseDelayMs) ||
        (t.lastCustomerAt && t.lastAgentAt >= t.lastCustomerAt ? t.lastAgentAt - t.lastCustomerAt : 0);
      if (t.answered === true && responseDelayMs > thresholdMs) {
        lateResponses.push({ ...t, responseDelayH: Math.round(responseDelayMs / 3600000) });
      }

      if (!t.lastCustomerAt) continue;
      if (t.lastAgentAt && t.lastAgentAt >= t.lastCustomerAt) continue;
      if (t.resolvedForCustomerAt === t.lastCustomerAt) continue;

      const since = t.lastCustomerAt;
      const pendingSinceAt = Math.max(Number(t.lastCustomerAt) || 0, Number(t.assignedAt) || 0);
      const elapsedMs = now - since;
      const pendingElapsedMs = now - pendingSinceAt;
      const elapsedH = elapsedMs / 3600000;
      const item = { ...t, waitH: Math.round(elapsedH), pendingSinceAt };
      const assignedToAgent = !!settings.agentName && !!t.assignedTo &&
        t.assignedTo.toLowerCase().includes(settings.agentName.toLowerCase());
      const priorityAlertMinutes = getPendingAlertMinutes(t.priority);
      if (assignedToAgent && pendingElapsedMs >= priorityAlertMinutes * 60000) {
        pending.push({ ...item, pendingAlertMinutes: priorityAlertMinutes });
      }
      if (elapsedMs < thresholdMs) {
        waiting.push(item);
        continue;
      }
      if (t.snoozeUntil && t.snoozeUntil > now) {
        item.snoozeH = Math.max(1, Math.round((t.snoozeUntil - now) / 3600000));
        snoozed.push(item);
      }
      missed.push(item);
    }

    missed.sort((a, b) => b.waitH - a.waitH);
    waiting.sort((a, b) => b.waitH - a.waitH);
    snoozed.sort((a, b) => a.snoozeH - b.snoozeH);
    lateResponses.sort((a, b) => b.responseDelayH - a.responseDelayH);
    pending.sort((a, b) => b.waitH - a.waitH);
    return { missed, waiting, snoozed, lateResponses, pending };
  }

async function saveTickets() {
  await store.set({ tickets, customerReplies });
  console.log("[MRT] saved tickets:", Object.keys(tickets).length);
}

async function claimScan(scanType, total = 0) {
  const { deepScan = {} } = await store.get("deepScan");
  const lastUpdate = Number(deepScan.updatedAt || deepScan.startedAt) || 0;
  if (deepScan.active && deepScan.ownerId !== scanOwnerId &&
      lastUpdate && Date.now() - lastUpdate <= scanStaleMs) return false;

  scanStartedAt = Date.now();
  await store.set({
    deepScan: {
      active: true,
      ownerId: scanOwnerId,
      scanType,
      phase: "collect",
      total,
      done: 0,
      remaining: total,
      startedAt: scanStartedAt,
      updatedAt: scanStartedAt
    }
  });
  return true;
}

async function updateOwnedScan(fields) {
  const { deepScan = {} } = await store.get("deepScan");
  if (!deepScan.active || deepScan.ownerId !== scanOwnerId) return false;
  await store.set({
    deepScan: {
      ...deepScan,
      ...fields,
      ownerId: scanOwnerId,
      startedAt: scanStartedAt || deepScan.startedAt || Date.now(),
      updatedAt: Date.now()
    }
  });
  return true;
}

async function releaseOwnedScan() {
  const { deepScan = {} } = await store.get("deepScan");
  if (deepScan.ownerId !== scanOwnerId) return;
  await store.set({
    deepScan: {
      ...deepScan,
      active: false,
      remaining: 0,
      queue: [],
      updatedAt: Date.now()
    }
  });
}

  // ---------------- light scan ----------------
  async function fullScan() {
    if (!settings.enabled || !isPanel() || deepScanState.active || autoMyTicketsScanRunning || quickUnreadScanPromise) return;

    const list = scanList();
    list.forEach(applyListRow);

    const tid = openTicketId();
    if (tid) {
      const msgs = parseConversation();
      if (msgs.length) {
        const row = list.find((r) => r.id === tid) || {};
        const assignedTo = fact("Assigned");
        if (isMyTicketsScopeActive()) await saveDetectedAgentName([assignedTo]);
        applyConversation(tid, {
          name: row.name,
          category: fact("Category"),
          assignedTo,
          assignmentAt: findAssignmentTime(assignedTo),
          assignmentKnown: hasFact("Assigned")
        }, msgs);
      }
    }

    await saveTickets();
    render();
  }

  // ---------------- collect all tickets (Mine queue) ----------------
async function ensureScanScope() {
  const isMyTickets = (el) => ["my tickets", "mine", "my"].includes(pillText(el));
  let scope = qsa(".scope-pill").find(isMyTickets);
  if (!scope) {
    scope = [...document.querySelectorAll("button, [role='tab'], [role='button'], a")]
      .find(isMyTickets);
  }
  // If no explicit scope pill is found but tickets are already visible, use current list.
  if (!scope) {
    let guard = 0;
    while (guard < 20 && !qs(".ticket-item")) {
      await sleep(300);
      guard++;
    }
    if (qs(".ticket-item")) {
      console.log("[MRT] ensureScanScope: no scope pill, using visible ticket list");
      return true;
    }
    console.warn("[MRT] ensureScanScope: 'My tickets' scope not found");
    return false;
  }
  const isActive = (el) => el.classList.contains("scope-pill--on") ||
    el.classList.contains("active") ||
    el.classList.contains("selected") ||
    el.getAttribute("aria-selected") === "true";
  const alreadyActive = isActive(scope);
  if (!alreadyActive) {
    scope.click();
    let activeGuard = 0;
    while (activeGuard < 30) {
      await sleep(200);
      activeGuard++;
      scope = qsa(".scope-pill").find(isMyTickets) || scope;
      if (isActive(scope)) break;
    }
    if (!isActive(scope)) {
      console.warn("[MRT] ensureScanScope: 'My tickets' scope did not become active");
      return false;
    }
    await sleep(1000);
  }
  let guard = 0;
  while (guard < 40 && !qs(".ticket-item")) {
    await sleep(300);
    guard++;
  }
  await sleep(500);
  const visibleCount = scanList().length;
  console.log("[MRT] ensureScanScope done, tickets visible:", visibleCount);
  return visibleCount > 0 || !!qs(".ticket-item");
}

async function collectAllTickets(maxMs = 600000) {
  // wait for ticket list to render (SPA) before collecting
  let renderGuard = 0;
  while (renderGuard < 40 && !qs(".ticket-item")) {
    await sleep(300);
    renderGuard++;
  }
  await sleep(500);
  const seen = new Set();
  const collectedRows = new Map();
  const t0 = Date.now();
    let noProgress = 0;
    let complete = false;

while (Date.now() - t0 < maxMs) {
  const rows = scanList();
  rows.forEach((r) => {
    seen.add(r.id);
    collectedRows.set(r.id, r);
  });
  deepScanState = { active: true, phase: "collect", done: seen.size, total: 0, remaining: 0 };
      setProgress(`🔄 Loading tickets... ${seen.size} found`);
      render();

      const btn = qs(".load-more__button") || qsa("button, [role='button'], a").find((el) => /load older|load more|show more|older tickets|next page/i.test((el.textContent || "").toLowerCase()));
      if (!btn) { complete = true; break; }
      if (btn.getAttribute("aria-busy") === "true" || /\bloading\b/i.test(btn.textContent || "")) {
        await sleep(500);
        continue;
      }
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        complete = true;
        break;
      }

      const previousUniqueCount = seen.size;

      try { btn.scrollIntoView({ block: "center" }); } catch (error) {}
      await sleep(300);
      btn.click();
      let waitCount = 0;
      let endOfList = false;
      let unavailableCount = 0;
      while (waitCount < 120 && Date.now() - t0 < maxMs) {
        await sleep(250);
        const newRows = scanList().filter((row) => !seen.has(row.id));
        if (newRows.length) break;
        const currentButton = qs(".load-more__button") || qsa("button, [role='button'], a")
          .find((el) => /load older|load more|show more|older tickets|next page/i.test((el.textContent || "").toLowerCase()));
        if (!currentButton) {
          unavailableCount++;
          if (unavailableCount >= 20) {
            endOfList = true;
            break;
          }
        } else {
          unavailableCount = 0;
          const buttonText = (currentButton.textContent || "").toLowerCase();
          const isLoading = currentButton.getAttribute("aria-busy") === "true" || /\bloading\b/.test(buttonText);
          if ((currentButton.disabled || currentButton.getAttribute("aria-disabled") === "true") && !isLoading) {
            unavailableCount++;
            if (unavailableCount >= 20) {
              endOfList = true;
              break;
            }
          } else {
            unavailableCount = 0;
          }
        }
        waitCount++;
      }
      const afterClickRows = scanList();
      afterClickRows.forEach((row) => {
        seen.add(row.id);
        collectedRows.set(row.id, row);
      });
      if (seen.size <= previousUniqueCount) {
        noProgress++;
        if (endOfList) {
          complete = true;
          break;
        }
        if (noProgress >= 3) {
          console.warn(`[MRT] Ticket pagination stalled after ${noProgress} load-more attempts; collected ${seen.size} tickets.`);
          break;
        }
        await sleep(1000);
      } else {
        noProgress = 0;
      }
    }

    scanList().forEach((r) => {
      seen.add(r.id);
      collectedRows.set(r.id, r);
    });
    console.log("[MRT] collectAllTickets collected:", seen.size);
    if (!complete) console.warn("[MRT] Ticket pagination was not confirmed complete.");
    return { ids: [...seen], rows: [...collectedRows.values()], complete };
  }

  // ---------------- deep scan (in-page, NO reload) ----------------
  // Panel SPA — ticket row click korlei conversation reload chara bode.
  // Tai page refresh/panel blink kichui hobe na.
  function findRowEl(id) {
    return qsa(".ticket-item").find((btn) =>
      (qs(".ticket-item__id", btn)?.textContent || "").replace("#", "").trim() === id) || null;
  }

function currentOpenId() {
  const v = (fact("Ticket") || "").replace("#", "").trim();
  if (/^\d+$/.test(v)) return v;
  const activeRow = qsa(".ticket-item").find((btn) =>
    btn.classList.contains("active") || btn.classList.contains("is-active") ||
    btn.classList.contains("selected") || btn.getAttribute("aria-selected") === "true" ||
    btn.getAttribute("aria-current") === "true");
  if (activeRow) {
    const id = (qs(".ticket-item__id", activeRow)?.textContent || "").replace("#", "").trim();
    if (/^\d+$/.test(id)) return id;
  }
  const highlighted = qsa(".ticket-item").find((btn) => /\b(active|selected|open|current)\b/i.test(btn.className || ""));
  if (highlighted) {
    const id = (qs(".ticket-item__id", highlighted)?.textContent || "").replace("#", "").trim();
    if (/^\d+$/.test(id)) return id;
  }
  const urlId = openTicketId();
  return urlId && /^\d+$/.test(urlId) ? urlId : null;
}

function conversationSignature() {
  return qsa(".msg").map((message) => {
    const time = qs("time[datetime]", message)?.getAttribute("datetime") || "";
    const text = (qs(".msg__text", message)?.textContent || message.textContent || "").trim();
    return `${time}:${text}`;
  }).join("|");
}

  async function ensureRowLoaded(id) {
    let row = findRowEl(id);
    let guard = 0;
    while (!row && guard < 15) {
      let btn = qs(".load-more__button");
      if (!btn) btn = qsa("button, [role='button'], a").find((el) => /load older|load more|show more|older tickets|next page/i.test((el.textContent || "").toLowerCase()));
      if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") break;
      const previousCount = qsa(".ticket-item").length;
      try { btn.scrollIntoView({ block: "center" }); } catch (error) {}
      btn.click();
      for (let wait = 0; wait < 40; wait++) {
        await sleep(250);
        if (findRowEl(id) || qsa(".ticket-item").length > previousCount) break;
      }
      row = findRowEl(id);
      guard++;
    }
    return row;
  }

  async function openTicketInPlace(id) {
    const row = await ensureRowLoaded(id);
    if (!row) return false;
    const beforeId = currentOpenId();
    const beforeSignature = conversationSignature();
    if (beforeId === id && beforeSignature) return true;
    try { row.scrollIntoView({ block: "center" }); } catch (e) {}
    row.click();
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      const messages = qsa(".msg--inbound, .msg--outbound, .msg");
      const changedConversation = conversationSignature() !== beforeSignature;
      if (currentOpenId() === id && messages.length && (changedConversation || beforeId === id)) return true;
      if ((fact("Ticket") || "").replace("#", "").trim() === id && messages.length) return true;
    }
    return false;
  }

  async function runDeepScan(ids, { totalFound = ids.length, skipped = 0, complete = true, scanType = "deep" } = {}) {
    const total = ids.length;
    let done = 0;
    let checked = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      if (cancelDeepScan) break;
      const id = ids[i];
      let ticketChecked = false;
      let ticketFailed = false;

      deepScanState = { active: true, phase: "scan", done, total, remaining: total - done };
      setProgress(`🔍 #${id} khulche... (${done}/${total})`);
      render();

      try {
        const opened = await openTicketInPlace(id);
        if (opened) {
          await sleep(400);
          let msgs = parseConversation();
          if (!msgs.length) {
            await sleep(1200);
            msgs = parseConversation();
          }
          const row = scanList().find((r) => r.id === id) || {};
          const name = row.name || openTicketName(id);
          if (msgs.length) {
            applyConversation(id, {
              name,
              category: fact("Category"),
              assignedTo: fact("Assigned"),
              assignmentAt: findAssignmentTime(fact("Assigned")),
              assignmentKnown: hasFact("Assigned")
            }, msgs);
            checked++;
            ticketChecked = true;
          } else {
            ticketFailed = true;
            applyListRow({ id, name, lastActivityAt: row.lastActivityAt, preview: row.preview, unread: row.unread });
          }
        } else {
          ticketFailed = true;
        }

        const scannedRow = scanList().find((r) => r.id === id);
        if (scannedRow && tickets[id]) {
          tickets[id].lastActivityAt = scannedRow.lastActivityAt || tickets[id].lastActivityAt || 0;
          tickets[id].unread = scannedRow.unread || 0;
          if (opened) {
            tickets[id].lastAutoScanActivityAt = scannedRow.lastActivityAt || tickets[id].lastAutoScanActivityAt || 0;
            tickets[id].lastAutoScanUnread = scannedRow.unread || 0;
          }
        }
        await saveTickets();
      } catch (error) {
        if (!ticketChecked) ticketFailed = true;
        console.error(`[MRT] Deep scan failed for ticket #${id}; continuing with the next ticket:`, error);
      }
      if (ticketFailed) failed++;

      done = i + 1;
      deepScanState = { active: true, phase: "scan", done, total, remaining: total - done };
      await updateOwnedScan({ phase: "scan", total, done, remaining: total - done });
      setProgress(`${ticketChecked ? "✅" : "⚠️"} #${id} ${ticketChecked ? "checked" : ticketFailed ? "could not read" : "skipped"} — ${done}/${total}`);
      render();
      await sleep(120);
    }

    cancelDeepScan = false;
    await saveDetectedAgentName(ids.map((id) => tickets[id]?.assignedTo || ""));
    await releaseOwnedScan();
    await finishDeepScan(done, total, totalFound, skipped, complete, checked, failed, scanType, Math.max(0, total - done));
  }

  async function startDeepScan() {
    if (deepScanState.active || autoMyTicketsScanRunning) return;
    if (!await claimScan("deep")) {
      setProgress("⚠️ A ticket scan is already running in another Packzy tab");
      render();
      return;
    }
    cancelDeepScan = false;
    setPanelOpen(true);

    deepScanState = { active: true, phase: "collect", done: 0, total: 0, remaining: 0 };
    setProgress("🔄 Finding My tickets...");
    render();

    try {
      if (quickUnreadScanPromise) await quickUnreadScanPromise;
      const scopeReady = await ensureScanScope();
      if (!scopeReady) {
        deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
        await releaseOwnedScan();
        setProgress("⚠️ My tickets list not found - select My tickets/Mine scope in Packzy and retry");
        render();
        return;
      }
      const { ids, rows, complete } = await collectAllTickets();

      if (!ids.length) {
        setProgress("⚠️ No tickets found - check if inbox is open");
        deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
        await releaseOwnedScan();
        render();
        return;
      }

      rows.forEach(applyListRow);
      setProgress(`${complete ? "✅" : "⚠️"} Total ${ids.length} My tickets found - all ${ids.length} conversations being checked`);
      await updateOwnedScan({ phase: "scan", total: ids.length, done: 0, remaining: ids.length });
      await runDeepScan(ids, { totalFound: ids.length, skipped: 0, complete });
    } catch (error) {
      console.error("[MRT] Deep scan failed:", error);
      deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
      setProgress("⚠️ Deep scan failed - see console for details");
      await releaseOwnedScan();
      render();
    }
  }

  async function startAutoMyTicketsScan(force = false) {
    let bootWait = 0;
    while (!bootReady && bootWait < 120) {
      await sleep(250);
      bootWait++;
    }
    if (!settings.enabled || (!force && settings.autoMyTicketsScan !== true) || autoMyTicketsScanRunning ||
        deepScanState.active || !isPanel()) return;
    if (!await claimScan("auto")) return;

    autoMyTicketsScanRunning = true;
    deepScanState = { active: true, phase: "collect", done: 0, total: 0, remaining: 0 };
    setProgress("🔄 Auto-scanning My tickets...");
    render();

    try {
      if (quickUnreadScanPromise) await quickUnreadScanPromise;
      if (!await ensureScanScope()) {
        setProgress("⚠️ Auto scan: My tickets/Mine list not found");
        return;
      }

      const { ids, rows, complete } = await collectAllTickets();
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const candidates = [];
      let skipped = 0;

      for (const id of ids) {
        const row = rowById.get(id);
        if (!row) continue;
        const previous = tickets[id];
        const hasAutoBaseline = Number.isFinite(Number(previous?.lastAutoScanActivityAt));
        const parsedActivity = Math.max(Number(previous?.lastCustomerAt) || 0, Number(previous?.lastAgentAt) || 0);
        const oldActivity = hasAutoBaseline ? Number(previous.lastAutoScanActivityAt) : parsedActivity;
        const oldUnread = hasAutoBaseline ? Number(previous.lastAutoScanUnread) || 0 : 0;
        const needsInitialScan = previous?.source !== "conversation";
        const changedActivity = !!previous && (hasAutoBaseline || parsedActivity > 0) &&
          !!row.lastActivityAt && row.lastActivityAt > oldActivity;
        const changedUnread = row.unread > 0 && row.unread > oldUnread;
        const newUnreadTicket = !previous && row.unread > 0;
        const currentlyUnanswered = !!previous?.lastCustomerAt &&
          !(previous.lastAgentAt && previous.lastAgentAt >= previous.lastCustomerAt) &&
          previous.resolvedForCustomerAt !== previous.lastCustomerAt;

        applyListRow(row);
        if (needsInitialScan || changedActivity || changedUnread || newUnreadTicket || (force && currentlyUnanswered)) {
          if (!previous?.lastCustomerAt && row.unread > 0) {
            tickets[id].autoNotifyInitialReply = true;
          }
          candidates.push(id);
        } else {
          tickets[id].lastAutoScanActivityAt = row.lastActivityAt || oldActivity;
          tickets[id].lastAutoScanUnread = row.unread;
          skipped++;
        }
      }

      await store.set({
        lastAutoMyTicketsScanAt: Date.now(),
      });
      await saveTickets();

      if (!candidates.length) {
        await releaseOwnedScan();
        deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
        await store.set({
          lastAutoMyTicketsScanAt: Date.now(),
          lastScanSummary: {
            type: "auto",
            finishedAt: Date.now(),
            listed: ids.length,
            checked: 0,
            skipped,
            failed: 0,
            paginationComplete: complete
          }
        });
        setProgress(`${complete ? "✅" : "⚠️"} Auto My tickets scan: ${ids.length} tickets listed; no new activity${complete ? "" : " — pagination not fully confirmed"}`);
        render();
        return;
      }

      deepScanState = { active: true, phase: "scan", done: 0, total: candidates.length, remaining: candidates.length };
      await updateOwnedScan({ phase: "scan", total: candidates.length, done: 0, remaining: candidates.length });
      setProgress(`🔍 Checking ${candidates.length} My tickets conversations with new activity or not scanned yet`);
      render();
      await runDeepScan(candidates, { totalFound: ids.length, skipped, complete, scanType: "auto" });
      await store.set({ lastAutoMyTicketsScanAt: Date.now() });
      if (!complete) console.log("[MRT] My tickets pagination partial - collected", ids.length, "tickets.");
    } catch (error) {
      console.error("[MRT] Auto My tickets scan failed:", error);
      setProgress("⚠️ Auto My tickets scan failed - see console for details");
      deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
      await releaseOwnedScan();
      render();
    } finally {
      if (deepScanState.active) {
        deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
        await releaseOwnedScan();
        render();
      }
      autoMyTicketsScanRunning = false;
    }
  }

  async function finishDeepScan(done, total, totalFound = total, skipped = 0, complete = true, checked = done, failed = 0, scanType = "deep", notAttempted = 0) {
    const finishedAt = Date.now();
    const scanUpdate = {
      lastScanSummary: {
        type: scanType,
        finishedAt,
        listed: totalFound,
        checked,
        skipped,
        failed,
        notAttempted,
        paginationComplete: complete
      }
    };
    scanUpdate[scanType === "auto" ? "lastAutoMyTicketsScanAt" : "lastDeepScanAt"] = finishedAt;
    await store.set(scanUpdate);
    deepScanState = { active: false, phase: "", done, total, remaining: 0 };
    setProgress(`${complete ? "✅" : "⚠️"} Deep scan finished - Total ${totalFound} ticket found${complete ? "" : " (pagination not fully confirmed)"}; ${checked} conversations checked, ${failed} could not open/read, ${skipped} unchanged skipped${notAttempted ? `, ${notAttempted} not started` : ""}`);
    render();
  }

  async function handleRatingChange(summary) {
    try {
      const { ratingSummary: prev = null, ratingChanges = [] } = await store.get(["ratingSummary", "ratingChanges"]);
      const changes = [];
      if (prev) {
        if (prev.myRating != null && summary.myRating != null && prev.myRating !== summary.myRating)
          changes.push({ field: "My rating", from: prev.myRating, to: summary.myRating });
        if (prev.satisfiedPct != null && summary.satisfiedPct != null && prev.satisfiedPct !== summary.satisfiedPct)
          changes.push({ field: "Satisfied", from: prev.satisfiedPct + "%", to: summary.satisfiedPct + "%" });
        if (prev.teamRating != null && summary.teamRating != null && prev.teamRating !== summary.teamRating)
          changes.push({ field: "Team rating", from: prev.teamRating, to: summary.teamRating });
        if (prev.teamSatisfiedPct != null && summary.teamSatisfiedPct != null && prev.teamSatisfiedPct !== summary.teamSatisfiedPct)
          changes.push({ field: "Team satisfied", from: prev.teamSatisfiedPct + "%", to: summary.teamSatisfiedPct + "%" });
      }
      if (!changes.length) return;
      const list = Array.isArray(ratingChanges) ? ratingChanges.slice() : [];
      for (const c of changes) {
        const at = Date.now();
        list.unshift({ ...c, at, id: `rating-${c.field}-${at}` });
        const fromNum = Number(String(c.from).replace("%", ""));
        const toNum = Number(String(c.to).replace("%", ""));
        const arrow = toNum > fromNum ? "📈 increased" : "📉 decreased";
        try {
          chrome.runtime.sendMessage({
            type: "MRT_NOTIFY",
            category: "rating",
            eventKey: `rating:${c.field}:${c.from}->${c.to}:${at}`,
            title: "Rating update",
            text: `${c.field}: ${c.from} → ${c.to} ${arrow}`
          });
        } catch (e) {}
      }
      await store.set({ ratingChanges: list.slice(0, 100) });
    } catch (e) {}
  }

  // ---------------- rating scrape ----------------
  function scrapeRatingSummary() {
    try {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const myMatch = text.match(/My rating\s*(\d+)\s*days\s*([\d.]+)/i);
      const countMatch = text.match(/(\d+)\s*ratings?\s*[·•]\s*(\d+)\s*%\s*satisfied/i);
      const teamMatch = text.match(/Team:\s*★?\s*([\d.]+)\s*[·•]\s*(\d+)\s*%/i);
      if (!myMatch && !countMatch && !teamMatch) return;
      const summary = {
        days: myMatch ? Number(myMatch[1]) : null,
        myRating: myMatch ? Number(myMatch[2]) : null,
        ratingCount: countMatch ? Number(countMatch[1]) : null,
        satisfiedPct: countMatch ? Number(countMatch[2]) : null,
        teamRating: teamMatch ? Number(teamMatch[1]) : null,
        teamSatisfiedPct: teamMatch ? Number(teamMatch[2]) : null,
        scrapedAt: Date.now()
      };
      handleRatingChange(summary).catch(() => {});
      store.set({ ratingSummary: summary }).catch(() => {});
      // also notify dashboard via storage (already)
    } catch (e) {}
  }

  // ---------------- sound alert ----------------
  let prevMissedIds = null;
  let prevPendingIds = null;
  let audioCtx = null;

  function beep() {
    if (!settings.soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.12;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.18);
      setTimeout(() => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.type = "sine";
        o2.frequency.value = 1174;
        g2.gain.value = 0.1;
        o2.connect(g2);
        g2.connect(audioCtx.destination);
        o2.start();
        o2.stop(audioCtx.currentTime + 0.18);
      }, 220);
    } catch (e) {}
  }

  // ---------------- UI ----------------
  function setProgress(txt) {
    progressText = txt;
    const el = panel?.querySelector("#mrt-progress");
    if (el) el.textContent = txt;
    else render();
  }

  function setPanelOpen(open) {
    panelOpen = !!open;
    panel?.classList.toggle("mrt-hidden", !panelOpen);
    fab?.setAttribute("aria-expanded", String(panelOpen));
    try {
      sessionStorage.setItem("mrt-panel-open", String(panelOpen));
    } catch (error) {
      console.warn("[MRT] Could not save this tab's panel state:", error);
    }
  }

  function ensureUI() {
    if (fab) return;

    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "mrt-fab";
    fab.setAttribute("aria-label", "SFC TICKET CHECKER Open panel");
    fab.setAttribute("aria-expanded", String(panelOpen));
    fab.setAttribute("aria-controls", "mrt-panel");
    fab.innerHTML = `${icon("tracker")}<span>SFC TICKET CHECKER</span><span class="mrt-fab-count" hidden>0</span>`;
    fab.title = "SFC TICKET CHECKER";
    fab.addEventListener("click", () => setPanelOpen(!panelOpen));

    panel = document.createElement("div");
    panel.className = "mrt-panel";
    panel.id = "mrt-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "SFC TICKET CHECKER ticket alerts");
    if (!panelOpen) panel.classList.add("mrt-hidden");

    document.documentElement.appendChild(panel);
    document.documentElement.appendChild(fab);
    render();
  }

  function render() {
    if (!panel) return;
    const { missed, waiting, snoozed, lateResponses, pending } = computeAlerts();
    const replyWarningHours = getReplyWarningHours();
    const totalAlerts = missed.length + lateResponses.length + pending.length;
    let updatedMissedAlert = false;
    let updatedPendingAlert = false;
    for (const ticket of pending) {
      const priority = String(ticket.priority || "normal").toLowerCase();
      const baseEventKey = `${ticket.pendingSinceAt}:${ticket.lastCustomerAt}:${settings.agentName}`;
      const pendingEventKey = `${baseEventKey}:${priority}`;
      const savedTicket = tickets[ticket.id];
      if (!savedTicket || savedTicket.lastPendingAlertFor === pendingEventKey) continue;
      if (savedTicket.lastPendingAlertFor === baseEventKey) {
        savedTicket.lastPendingAlertFor = pendingEventKey;
        updatedPendingAlert = true;
        continue;
      }
      savedTicket.lastPendingAlertFor = pendingEventKey;
      updatedPendingAlert = true;
      try {
        chrome.runtime.sendMessage({
          type: "MRT_NOTIFY",
          category: "pending",
          eventKey: `pending:${ticket.id}:${ticket.pendingSinceAt}:${ticket.lastCustomerAt}:${priority}`,
          title: `${priority === "urgent" ? "Urgent" : priority === "high" ? "High priority" : "Assigned"} ticket needs a reply`,
          text: `#${ticket.id} · ${ticket.name || "customer"}: ${ticket.priority || "Normal"} priority, no reply after ${ticket.pendingAlertMinutes} min; waiting ${timeAgo(ticket.pendingSinceAt || ticket.lastCustomerAt)}`
        });
      } catch (error) {
        console.error("[MRT] Could not notify about a pending assigned ticket:", error);
      }
    }
    for (const ticket of missed) {
      const savedTicket = tickets[ticket.id];
      if (!savedTicket || savedTicket.lastMissedAlertFor === ticket.lastCustomerAt) continue;
      savedTicket.lastMissedAlertFor = ticket.lastCustomerAt;
      updatedMissedAlert = true;
      try {
        chrome.runtime.sendMessage({
          type: "MRT_NOTIFY",
          category: "missed",
          eventKey: `missed:${ticket.id}:${ticket.lastCustomerAt}`,
          title: "Customer reply needs attention",
          text: `#${ticket.id} · ${ticket.name || "customer"}: no agent reply for ${timeAgo(ticket.lastCustomerAt)}`
        });
      } catch (error) {
        console.error("[MRT] Could not notify about an overdue customer reply:", error);
      }
    }
    if (updatedMissedAlert || updatedPendingAlert) {
      saveTickets().catch((error) => console.error("[MRT] Could not save overdue alert state:", error));
    }

    // notun missed hole sound + notification signal
    const idsNow = new Set(missed.map((t) => t.id));
    const pendingIdsNow = new Set(pending.map((t) => t.id));
    if (prevMissedIds !== null || prevPendingIds !== null) {
      const isNewMissed = prevMissedIds !== null && [...idsNow].some((id) => !prevMissedIds.has(id));
      const isNewPending = prevPendingIds !== null && [...pendingIdsNow].some((id) => !prevPendingIds.has(id));
      if (isNewMissed || isNewPending) beep();
    }
    prevMissedIds = idsNow;
    prevPendingIds = pendingIdsNow;

    try { chrome.runtime.sendMessage({ type: "MRT_BADGE", count: totalAlerts }); } catch (e) {}

    const badge = fab?.querySelector(".mrt-fab-count");
    if (badge) {
      badge.textContent = totalAlerts;
      badge.hidden = totalAlerts === 0;
      fab.classList.toggle("mrt-alert", missed.length > 0);
      fab.classList.toggle("mrt-warn", missed.length === 0 && (lateResponses.length > 0 || pending.length > 0));
    }

    const deepLabel = deepScanState.active
      ? `${icon("close")}<span>Close (${deepScanState.remaining})</span>`
      : `${icon("scan")}<span>Deep Scan</span>`;
    const prevScroll = panel.querySelector(".mrt-list")?.scrollTop || 0;

    // progress bar
    const ds = deepScanState;
    let barHTML = "";
    if (ds.active) {
      const pct = ds.total ? Math.min(100, Math.round((ds.done / ds.total) * 100)) : 0;
      const indeterminate = ds.phase === "collect" || !ds.total;
      barHTML = `
        <div class="mrt-bar-wrap">
          <div class="mrt-bar ${indeterminate ? "mrt-bar--indef" : ""}">
            <div class="mrt-bar-fill" style="${indeterminate ? "" : `width:${pct}%`}"></div>
          </div>
          <div class="mrt-bar-txt">
            ${indeterminate
              ? `${icon("refresh")} Loading tickets... ${ds.done || 0}`
              : `${ds.done}/${ds.total} · <b>${pct}%</b> · baki ${ds.remaining}`}
          </div>
        </div>`;
    }

    const itemHTML = (t, mode) => `
      <div class="mrt-item${mode === "waiting" ? " mrt-item--waiting" : ""}" data-id="${esc(t.id)}">
        <div class="mrt-item-top">
          <span class="mrt-tid">#${esc(t.id)}</span>
          <span class="mrt-wait">${mode === "late" ? icon("clock") + esc(t.responseDelayH) + "h response" : esc(timeAgo(mode === "pending" ? (t.pendingSinceAt || t.lastCustomerAt) : t.lastCustomerAt)) + " ago · no reply"}</span>
        </div>
        <div class="mrt-item-sub">
          ${esc(t.name || "")}${t.category ? " · " + esc(t.category) : ""}
          ${t.priority ? `<span class="mrt-pri mrt-pri--${esc(t.priority)}">${esc(t.priority)}</span>` : ""}
        </div>
        <div class="mrt-item-msg">${esc(mode === "late" ? (t.lastCustomerText || t.preview || "") : (t.preview || ""))}</div>
        ${mode === "late" ? `<div class="mrt-item-msg mrt-late-note">${icon("alert")} Agent reply took ${esc(t.responseDelayH)}h</div>` : ""}
        <div class="mrt-item-acts">
          <button class="mrt-mini mrt-mini-star" type="button" data-star="${esc(t.id)}">${tickets[t.id]?.starred ? "★ Starred" : "☆ Star"}</button>
          <button class="mrt-mini mrt-mini-primary" type="button" data-open="${esc(t.id)}">${icon("open")} Open</button>
          ${mode === "late" || mode === "waiting" || mode === "pending" ? "" : `<button class="mrt-mini" type="button" data-snooze="${esc(t.id)}">${icon("moon")} Snooze 12h</button>`}
        </div>
      </div>`;

    const waitingHTML = waiting.map((t) => itemHTML(t, "waiting")).join("");
    const pendingHTML = pending.map((t) => itemHTML(t, "pending")).join("");
    const missedHTML = missed.filter((t) => !(t.snoozeUntil > Date.now())).map((t) => itemHTML(t, "missed")).join("");
    const lateResponsesHTML = lateResponses.map((t) => itemHTML(t, "late")).join("");
    const snoozedHTML = snoozed.map((t) => `
      <div class="mrt-snoozed-row">
        <span>#${esc(t.id)} ${esc(t.name || "")}</span>
        <span class="mrt-snooze-left">${icon("moon")} ${esc(t.snoozeH)}h</span>
        <button class="mrt-mini mrt-icon-button" type="button" aria-label="Unsnooze ticket ${esc(t.id)}" data-unsnooze="${esc(t.id)}">${icon("close")}</button>
      </div>`).join("");

    panel.innerHTML = `
      <div class="mrt-head">
        <span class="mrt-brand-mark">${icon("tracker")}</span>
        <span class="mrt-brand-copy"><b>SFC TICKET CHECKER</b><small>MD SWAMPOD SARKAR</small></span>
        <span class="mrt-count">${totalAlerts}</span>
        <button class="mrt-close" type="button" aria-label="Panel Close">${icon("close")}</button>
      </div>
      <div class="mrt-tools">
        <button class="mrt-btn" type="button" data-act="refresh">${icon("refresh")}<span>Refresh</span></button>
          <button class="mrt-btn mrt-btn-primary" type="button" data-act="deep">${deepLabel}</button>
        <button class="mrt-btn" type="button" data-act="copy">${icon("copy")}<span>Copy IDs</span></button>
        <button class="mrt-btn" type="button" data-act="csv">${icon("file")}<span>CSV</span></button>
        <button class="mrt-btn" type="button" data-act="dashboard">${icon("dashboard")}<span>Dashboard</span></button>
      </div>
      ${barHTML}
      <div class="mrt-list">
        ${progressText ? `<div class="mrt-progress" id="mrt-progress">${esc(progressText)}</div>` : ""}
        ${pending.length ? `<div class="mrt-sec-head mrt-sec-pending">${icon("clock")}<b>Assigned · priority-based reply reminders</b><span>${pending.length}</span></div>${pendingHTML}` : ""}
        ${waiting.length ? `<div class="mrt-sec-head mrt-sec-waiting">${icon("clock")}<b>Waiting for reply · under ${replyWarningHours}h</b><span>${waiting.length}</span></div>${waitingHTML}` : ""}
        <div class="mrt-sec-head">${icon("alert")}<b>Missed replies</b><span>${missed.length}</span></div>
        ${missedHTML}
        <div class="mrt-sec-head mrt-sec-late">${icon("clock")}<b>Late reply - over ${replyWarningHours}h</b><span>${lateResponses.length}</span></div>
        ${lateResponsesHTML || `<div class="mrt-none">${replyWarningHours} No agent reply later than the threshold</div>`}
        ${snoozed.length ? `<div class="mrt-sec-head mrt-sec-snoozed">${icon("moon")}<b>Snoozed</b><span>${snoozed.length}</span></div>${snoozedHTML}` : ""}
        ${!missed.length && !waiting.length && !snoozed.length && !lateResponses.length && !pending.length ? `<div class="mrt-empty">${icon("check")}<b>All good</b><small>No missed replies right now</small></div>` : ""}
      </div>
      <div class="mrt-foot">
        <span>${icon("clock")} ${replyWarningHours} h without reply = warning${settings.onlyMine && settings.agentName ? " · mine only" : ""}</span>
        <span id="mrt-live-timer" class="mrt-live-timer"></span>
        <a href="#" data-act="settings">${icon("settings")} Settings</a>
      </div>`;

    panel.querySelector(".mrt-close").onclick = () => setPanelOpen(false);
    const listNow = panel.querySelector(".mrt-list");
    if (listNow) listNow.scrollTop = prevScroll;

    panel.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.preventDefault();
        const act = el.dataset.act;

        if (act === "refresh") fullScan();

        if (act === "copy") {
          await copyText(missed.map((t) => "#" + t.id).join("\n"));
          el.innerHTML = `${icon("check")}<span>Copied</span>`;
          setTimeout(() => { if (el.isConnected) el.innerHTML = `${icon("copy")}<span>Copy IDs</span>`; }, 1200);
        }

        if (act === "csv") {
          const rows = [["Status", "Ticket ID", "Name", "Category", "Priority", "Wait / response(h)", "Rule", "Last Message"]]
            .concat(missed.map((t) => ["Missed - no agent reply", "#" + t.id, t.name || "", t.category || "", t.priority || "", t.waitH ?? "", "Immediate", t.lastCustomerText || t.preview || ""]))
            .concat(lateResponses.map((t) => ["Agent reply over 12h", "#" + t.id, t.name || "", t.category || "", t.priority || "", t.responseDelayH ?? "", "12h warning", t.lastCustomerText || t.preview || ""]))
          const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, "'")}"`).join(",")).join("\n");
          const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `missed-replies-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
        }

        if (act === "dashboard") {
          try { chrome.runtime.sendMessage({ type: "MRT_OPEN_DASHBOARD" }); } catch (e) {}
        }

        if (act === "settings") {
          try { chrome.runtime.sendMessage({ type: "MRT_OPEN_OPTIONS" }); } catch (e) {}
        }

        if (act === "deep") {
          if (deepScanState.active) {
            cancelDeepScan = true;
            deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
            setProgress("⏹ Deep scan stopped");
          } else {
            startDeepScan();
          }
        }
      });
    });

    // ticket open
    panel.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.dataset.open;
        const ok = await openTicketInPlace(id);
        if (!ok) location.href = ticketUrl(id);
      });
    });

    // snooze 12h
    panel.querySelectorAll("[data-snooze]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.dataset.snooze;
        const t = tickets[id] || { id };
        t.snoozeUntil = Date.now() + 12 * 3600000;
        t.snoozedAt = Date.now();
        tickets[id] = t;
        await saveTickets();
        render();
      });
    });

    // star / unstar ticket
    panel.querySelectorAll("[data-star]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.dataset.star;
        if (!tickets[id]) tickets[id] = { id };
        tickets[id].starred = !tickets[id].starred;
        await saveTickets();
        render();
      });
    });
    panel.querySelectorAll("[data-unsnooze]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.dataset.unsnooze;
        if (tickets[id]) { delete tickets[id].snoozeUntil; delete tickets[id].snoozedAt; }
        await saveTickets();
        render();
      });
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  // ---------------- boot ----------------
  function quickUnreadScan() {
    if (!settings.enabled || !isPanel() || deepScanState.active || autoMyTicketsScanRunning || quickUnreadScanPromise) return;
    const rows = scanList();
    rows.forEach(applyListRow);
    const unreadIds = rows.filter((r) => r.unread > 0).map((r) => r.id).slice(0, 5);
    quickUnreadScanPromise = (async () => {
      for (const id of unreadIds) {
        if (deepScanState.active || autoMyTicketsScanRunning) break;
        const opened = await openTicketInPlace(id);
        if (deepScanState.active || autoMyTicketsScanRunning) break;
        if (opened) {
          await new Promise((r) => setTimeout(r, 400));
          let msgs = parseConversation();
          if (!msgs.length) {
            await new Promise((r) => setTimeout(r, 1200));
            msgs = parseConversation();
          }
          const row = scanList().find((r) => r.id === id) || {};
          if (msgs.length) {
            applyConversation(id, {
              name: row.name || openTicketName(id),
              category: fact("Category"),
              assignedTo: fact("Assigned"),
              assignmentAt: findAssignmentTime(fact("Assigned")),
              assignmentKnown: hasFact("Assigned")
            }, msgs);
            await saveTickets();
            render();
          }
        }
      }
    })().catch((error) => {
      console.error("[MRT] Quick unread scan failed:", error);
    }).finally(() => {
      quickUnreadScanPromise = null;
      if (!deepScanState.active && !autoMyTicketsScanRunning) fullScan();
    });
  }

  function hookScanning() {
    if (window.__MRT_SCAN_HOOKED__) return;
    window.__MRT_SCAN_HOOKED__ = true;

    setInterval(fullScan, Math.max(30, settings.autoScanSec) * 1000);
    setInterval(quickUnreadScan, 15000);
    setInterval(render, 30000);

    const updateTimer = () => {
      const el = document.getElementById("mrt-live-timer") || panel?.querySelector("#mrt-live-timer");
      if (!el) return;
      const tid = openTicketId();
      const t = tid ? tickets[tid] : null;
      if (t && t.lastCustomerAt && !(t.lastAgentAt && t.lastAgentAt >= t.lastCustomerAt)) {
        const ms = Date.now() - t.lastCustomerAt;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        el.textContent = `\u23F1 #${tid}: ${h}h ${m}m unanswered`;
      } else {
        el.textContent = "";
      }
    };
    setInterval(updateTimer, 30000);
    updateTimer();

    let tmo;
    const mo = new MutationObserver(() => {
      clearTimeout(tmo);
      tmo = setTimeout(fullScan, 700);
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(fullScan, 700);
      }
    }, 1000);
  }

  async function boot() {
    console.log("[MRT] boot", location.href);
    const s = await store.get(["settings", "tickets", "customerReplies"]);
    settings = {
      ...DEFAULTS,
      ...(s.settings || {})
    };
    tickets = s.tickets || {};
    customerReplies = Array.isArray(s.customerReplies) ? s.customerReplies : [];
    // prune stale tickets not updated in 7 days
    const sevenDays = 7 * 24 * 3600000;
    const now = Date.now();
    let pruned = false;
    for (const key of Object.keys(tickets)) {
      const tk = tickets[key];
      if (!tk.parsedAt || now - tk.parsedAt > sevenDays) { delete tickets[key]; pruned = true; }
    }
    if (pruned) await saveTickets();
    try {
      panelOpen = sessionStorage.getItem("mrt-panel-open") === "true";
    } catch (error) {
      console.warn("[MRT] Could not read this tab's panel state:", error);
    }

    if (!settings.enabled) return console.log("[MRT] disabled");
    if (!isPanel()) return console.log("[MRT] not panel page - skip");

    ensureUI(); // panel agei banao — collect/scan shuru theke dekha jabe

    // Clear legacy or abandoned scans, but never reset a scan owned by another live tab.
    const { deepScan: ds } = await store.get("deepScan");
    const lastUpdate = Number(ds?.updatedAt || ds?.startedAt) || 0;
    if (ds?.active && (!ds.ownerId || !lastUpdate || Date.now() - lastUpdate > scanStaleMs)) {
      await store.set({ deepScan: { ...ds, active: false, queue: [], updatedAt: Date.now() } });
    }
    bootReady = true;
    render();

    let tries = 0;
    const init = () => {
      tries++;
      const ready = !!qs(".ticket-item") || (openTicketId() && qsa(".msg").length > 0);
      if (ready) {
        console.log("[MRT] panel ready - scanning start");
        fullScan();
        hookScanning();
        scrapeRatingSummary();
        setInterval(scrapeRatingSummary, 60000);
        return;
      }
      if (tries < 30) setTimeout(init, 1000);
      else console.log("[MRT] Panel DOM not found (30s)");
    };
    init();
  }

  // ---------------- listeners ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MRT_AUTO_MY_TICKETS_SCAN") {
      startAutoMyTicketsScan(msg.force === true);
      sendResponse({ ok: true });
    }
    if (msg?.type === "MRT_TOGGLE_PANEL") {
      if (!panel) { ensureUI(); fullScan(); }
      setPanelOpen(!panelOpen);
      sendResponse({ ok: true });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.tickets) tickets = ch.tickets.newValue || tickets;
    if (area === "local" && ch.deepScan) {
      const ds = ch.deepScan.newValue || {};
      if (ds.ownerId === scanOwnerId && ds.active) {
        const remaining = ds.queue?.length || 0;
        const total = ds.total || remaining;
        const done = Number.isFinite(ds.done) ? ds.done : Math.max(0, total - remaining);
        deepScanState = { active: true, phase: ds.phase || "collect", done, total, remaining };
      } else if (ds.ownerId === scanOwnerId && !ds.active) {
        deepScanState = { active: false, phase: "", done: 0, total: 0, remaining: 0 };
      }
    }
    if (ch.settings) {
      const ns = ch.settings.newValue || {};
      settings = { ...settings, ...ns };
      render();
    }
  });

  boot();
})();
