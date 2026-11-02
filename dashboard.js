// Missed Reply Tracker — Dashboard
const PANEL_BASE = "https://dash.packzy.com/admin/support";

let settings = {};
let tickets = {};
let customerReplyEvents = [];
let lastDeepScanAt = 0;
let lastScanSummary = null;
let ratingSummary = null;
let ratingChanges = [];
let notifications = [];
let leaderboardEntries = [];
let leaderboardError = "";
let firebaseSyncStatus = null;
let notifFilter = "all";
let popupNotifFilter = "all";
let filter = "all";
let query = "";

const DEFAULTS = {
  onlyMine: true,
  agentName: "",
  autoMyTicketsScan: false,
  replyWarningHours: 12,
  pendingAlertMinutes: 10,
  highPriorityAlertMinutes: 5,
  urgentPriorityAlertMinutes: 1
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name) => {
  const paths = {
    alert: '<path d="m12 3 9 17H3l9-17Z"/><path d="M12 9v5m0 3h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    moon: '<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    reply: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z"/>',
    unsnooze: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
};

function switchView(view, btn) {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  document.body.dataset.view = view;
  document.querySelectorAll("section[data-view]").forEach((sec) => {
    const views = (sec.dataset.view || "").split(/\s+/);
    sec.style.display = views.includes(view) ? "block" : "none";
  });
}
window.switchView = switchView;
function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h ago`;
}

function ticketActivityAt(ticket) {
  return Math.max(
    0,
    Number(ticket.lastActivityAt) || 0,
    Number(ticket.lastCustomerAt) || 0,
    Number(ticket.lastAgentAt) || 0
  );
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function clearSnoozeIfNeeded(t) {
  if (!t.snoozeUntil) return;
  if (t.snoozeUntil <= Date.now()) { delete t.snoozeUntil; delete t.snoozedAt; return; }
  if (t.snoozedAt && t.lastActivityAt && t.lastActivityAt > t.snoozedAt) {
    delete t.snoozeUntil; delete t.snoozedAt;
  }
}

function compute() {
  const now = Date.now();
  const warningHours = Math.max(1, Math.min(168, Number(settings.replyWarningHours) || 12));
  const thresholdMs = warningHours * 3600000;
  const missed = [], waiting = [], snoozed = [], late = [], pending = [];

  for (const t of Object.values(tickets)) {
    clearSnoozeIfNeeded(t);

    if (settings.onlyMine && settings.agentName) {
      const a = (t.assignedTo || "").toLowerCase();
      if (a && !a.includes(settings.agentName.toLowerCase())) continue;
    }

    if (t.lastAgentAt && t.lastCustomerAt && t.lastAgentAt >= t.lastCustomerAt) {
      const responseDelayMs = Number(t.lastResponseDelayMs) || t.lastAgentAt - t.lastCustomerAt;
      if (responseDelayMs > thresholdMs) {
        late.push({ ...t, responseDelayH: Math.round(responseDelayMs / 3600000), slaH: warningHours });
      }
    }

    if (!t.lastCustomerAt) continue;
    if (t.lastAgentAt && t.lastAgentAt >= t.lastCustomerAt) continue;
    if (t.resolvedForCustomerAt === t.lastCustomerAt) continue;

    const since = t.lastCustomerAt;
    const elapsedMs = now - since;
    const elapsedH = elapsedMs / 3600000;
    const pendingSinceAt = Math.max(Number(t.lastCustomerAt) || 0, Number(t.assignedAt) || 0);
    const pendingElapsedMs = now - pendingSinceAt;
    const item = { ...t, waitH: Math.round(elapsedH), pendingSinceAt };
    const assignedToAgent = !!settings.agentName && !!t.assignedTo &&
      t.assignedTo.toLowerCase().includes(settings.agentName.toLowerCase());
    const priority = String(t.priority || "").toLowerCase();
    const configuredPendingMinutes = priority === "urgent"
      ? settings.urgentPriorityAlertMinutes
      : priority === "high" ? settings.highPriorityAlertMinutes : settings.pendingAlertMinutes;
    const pendingAlertMinutes = Math.max(1, Math.min(1440, Number(configuredPendingMinutes) ||
      (priority === "urgent" ? 1 : priority === "high" ? 5 : 10)));
    if (assignedToAgent && pendingElapsedMs >= pendingAlertMinutes * 60000 && elapsedMs < thresholdMs) {
      pending.push({ ...item, pendingAlertMinutes });
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
  late.sort((a, b) => b.responseDelayH - a.responseDelayH);
  pending.sort((a, b) => b.pendingSinceAt - a.pendingSinceAt);
  return { missed, waiting, snoozed, late, pending, warningHours };
}

async function load() {
  const s = await chrome.storage.local.get(["settings", "tickets", "customerReplies", "lastDeepScanAt", "lastAutoMyTicketsScanAt", "lastScanSummary", "ratingSummary", "ratingChanges", "notifications", "firebaseSyncStatus"]);
  console.log("[MRT Dashboard] loaded tickets:", Object.keys(s.tickets || {}).length, "replies:", (s.customerReplies || []).length);
  settings = { ...DEFAULTS, ...(s.settings || {}) };
  tickets = s.tickets || {};
  customerReplyEvents = Array.isArray(s.customerReplies) ? s.customerReplies : [];
  lastDeepScanAt = s.lastDeepScanAt || 0;
  lastScanSummary = s.lastScanSummary || null;
  ratingSummary = s.ratingSummary || null;
  ratingChanges = Array.isArray(s.ratingChanges) ? s.ratingChanges : [];
  notifications = Array.isArray(s.notifications) ? s.notifications : [];
  firebaseSyncStatus = s.firebaseSyncStatus || null;
  $("autoMyTicketsScan").checked = settings.autoMyTicketsScan === true;
  updateAutoScanStatus(s.lastAutoMyTicketsScanAt || 0);
  try { render(); } catch (e) { console.error("[MRT Dashboard] render error:", e); }
}

async function loadLeaderboard() {
  const statusEl = $("leaderboardSyncStatus");
  if (statusEl && !leaderboardEntries.length) statusEl.textContent = "Loading Firebase leaderboard…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "MRT_FIREBASE_GET_LEADERBOARD" });
    if (!response?.ok) throw new Error(response?.error || "Could not load leaderboard.");
    leaderboardEntries = response.entries;
    leaderboardError = "";
  } catch (error) {
    leaderboardError = error.message || String(error);
  }
  renderLeaderboard();
}

function sortLeaderboardEntries(entries) {
  return entries.slice().sort((a, b) => {
    const ratingA = a.rating != null && Number.isFinite(Number(a.rating))
      ? Math.round(Number(a.rating) * 10) / 10
      : -1;
    const ratingB = b.rating != null && Number.isFinite(Number(b.rating))
      ? Math.round(Number(b.rating) * 10) / 10
      : -1;
    const satisfactionA = a.satisfactionPct != null && Number.isFinite(Number(a.satisfactionPct))
      ? Number(a.satisfactionPct)
      : -1;
    const satisfactionB = b.satisfactionPct != null && Number.isFinite(Number(b.satisfactionPct))
      ? Number(b.satisfactionPct)
      : -1;
    return ratingB - ratingA ||
      satisfactionB - satisfactionA ||
      Number(b.totalTickets || 0) - Number(a.totalTickets || 0);
  });
}

function renderLeaderboard() {
  const body = $("leaderboardBody");
  const empty = $("leaderboardEmpty");
  const status = $("leaderboardSyncStatus");
  if (!body || !empty || !status) return;
  const entries = sortLeaderboardEntries(leaderboardEntries);
  body.innerHTML = entries.map((entry, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(entry.agentName || "Agent")}</td>
      <td>${entry.rating != null && Number.isFinite(Number(entry.rating)) ? `★ ${esc(Number(entry.rating).toFixed(1))}` : "—"}</td>
      <td>${entry.satisfactionPct != null && Number.isFinite(Number(entry.satisfactionPct)) ? `${esc(Number(entry.satisfactionPct))}%` : "—"}</td>
      <td>${esc(Number(entry.totalTickets) || 0)}</td>
    </tr>`).join("");
  empty.style.display = entries.length ? "none" : "block";
  empty.textContent = leaderboardError
    ? `Leaderboard unavailable: ${leaderboardError}`
    : "No agent stats have been synced yet. Open Packzy My tickets and run a Deep Scan to detect your agent name.";
  if (status) {
    const syncText = firebaseSyncStatus?.status === "error"
      ? `Your data sync failed: ${firebaseSyncStatus.message || "See Settings for details."}`
      : firebaseSyncStatus?.status === "synced"
        ? `${settings.agentName ? `Agent detected: ${settings.agentName}. ` : "Agent name will be detected from your Packzy My tickets scan. "}Your data synced ${timeAgo(firebaseSyncStatus.updatedAt)}. Leaderboard refreshes every 30 seconds.`
        : settings.agentName
          ? `Agent detected: ${settings.agentName}. Leaderboard refreshes every 30 seconds.`
          : "Agent name will be detected from your Packzy My tickets scan. Leaderboard refreshes every 30 seconds.";
    status.textContent = leaderboardError ? leaderboardError : syncText;
  }
}

function updateAutoScanStatus(lastScanAt = 0) {
  const status = $("autoScanStatus");
  if (!settings.autoMyTicketsScan) {
    status.textContent = "Auto scan off";
    return;
  }
  status.textContent = lastScanAt
    ? `On - last list check ${timeAgo(lastScanAt)}`
    : "On - awaiting first scan";
}

function rowHTML(t, status) {
  const activityAt = ticketActivityAt(t);
  const statusBadge = status === "missed"
    ? `<span class="badge missed">${icon("alert")} Missed</span>`
    : status === "pending"
      ? `<span class="badge pending">${icon("clock")} Assigned · reply overdue</span>`
    : status === "late"
      ? `<span class="badge late">${icon("clock")} Agent reply &gt;${esc(t.warningHours)}h</span>`
      : status === "waiting"
        ? `<span class="badge waiting">${icon("clock")} Waiting</span>`
          : status === "snoozed"
            ? `<span class="badge snoozed">${icon("moon")} Snoozed</span>`
            : status === "answered"
              ? `<span class="badge answered">Answered</span>`
              : `<span class="badge tracked">Tracked</span>`;

  const wait = status === "late"
    ? `${esc(t.responseDelayH)}h response`
    : status === "pending"
      ? `${esc(timeAgo(t.pendingSinceAt || t.lastCustomerAt))} pending`
    : status === "snoozed"
      ? `${icon("moon")} ${esc(t.snoozeH)}h`
      : status === "waiting"
        ? `${esc(t.waitH)}h`
        : status === "missed" ? `${esc(t.waitH)}h` : "—";

  const action = status === "snoozed"
    ? `<button class="mini" type="button" data-unsnooze="${esc(t.id)}">${icon("unsnooze")} Unsnooze</button>`
    : status === "missed" ? `<button class="mini" type="button" data-done="${esc(t.id)}">✓ Done</button> <button class="mini" type="button" data-snooze="${esc(t.id)}">${icon("moon")} 12h</button>` : "";

  return `
    <tr>
      <td>${statusBadge}</td>
        <td><button class="mini star-button${t.starred ? " is-starred" : ""}" type="button" data-star="${esc(t.id)}" aria-label="${t.starred ? "Unstar" : "Star"} ticket #${esc(t.id)}">${t.starred ? "★ Starred" : "☆ Star"}</button></td>
        <td><a class="tid" href="${PANEL_BASE}?ticket_id=${esc(t.id)}" target="_blank">#${esc(t.id)}</a></td>
      <td>${esc(t.name || "")}</td>
      <td>${esc(t.category || "")}</td>
      <td><span class="pri ${esc(t.priority || "")}">${esc(t.priority || "-")}</span></td>
      <td>${wait}</td>
      <td>${status === "pending" ? `${esc(t.pendingAlertMinutes || settings.pendingAlertMinutes || 10)} min assigned, no reply` : status === "late" ? `${esc(t.warningHours)}h warning` : status === "waiting" ? `Under ${esc(t.warningHours)}h` : status === "answered" ? "Agent replied" : status === "tracked" ? "No conversation data" : "No reply"}</td>
      <td>${activityAt ? new Date(activityAt).toLocaleString() : "—"}</td>
      <td class="msg">${esc(t.lastCustomerText || t.preview || "")}</td>
      <td>${action}</td>
    </tr>`;
}

function render() {
  const { missed, waiting, snoozed, late, pending, warningHours } = compute();
  const replyEvents = Object.values(tickets)
    .filter((t) => t && t.lastCustomerAt && !(t.lastAgentAt && t.lastAgentAt >= t.lastCustomerAt))
    .map((t) => ({ id: t.id, name: t.name || "Customer", text: t.lastCustomerText || t.preview || "", at: t.lastCustomerAt }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 100);

  $("numMissed").textContent = missed.length;
  $("numSnoozed").textContent = snoozed.length;
  $("numScanned").textContent = Object.keys(tickets).length;
  $("numLate").textContent = late.length;
  $("lateLabel").textContent = `${warningHours} h late`;
  $("lateFilter").textContent = `Late >${warningHours}h`;
  $("waitFilter").textContent = `Waiting <${warningHours}h`;
  const pendingFilter = document.querySelector('.filters .filter[data-filter="pending"]');
  if (pendingFilter) pendingFilter.textContent = "Pending (priority-based)";
  $("lastScan").textContent = lastScanSummary?.finishedAt
    ? "Last scan: " + new Date(lastScanSummary.finishedAt).toLocaleString()
    : lastDeepScanAt
      ? "Last scan: " + new Date(lastDeepScanAt).toLocaleString()
    : "Ekhono kono scan hoy nai";
  const coverage = $("scanCoverage");
  if (coverage) {
    if (!lastScanSummary) {
      coverage.textContent = "No scan summary yet. Run a Deep Scan to see coverage here.";
    } else {
      const finishedAt = lastScanSummary.finishedAt || 0;
      const freshness = finishedAt ? timeAgo(finishedAt) + " ago" : "";
      const completion = lastScanSummary.paginationComplete ? "pagination complete" : "pagination incomplete";
      const scanName = lastScanSummary.type === "auto" ? "Auto scan" : "Deep Scan";
      const missedCount = (lastScanSummary.notAttempted || 0) + (lastScanSummary.failed || 0);
      const coverageStatus = missedCount === 0 && lastScanSummary.paginationComplete
        ? "✅ All tickets covered"
        : `⚠️ ${missedCount} tickets missed`;
      coverage.textContent = `${scanName} · ${freshness} · ${lastScanSummary.listed || 0} tickets listed · ${lastScanSummary.checked || 0} conversations checked · ${lastScanSummary.skipped || 0} unchanged skipped · ${lastScanSummary.notAttempted || 0} not started · ${lastScanSummary.failed || 0} failed · ${completion} · ${coverageStatus}`;
    }
  }

  const ratingMy = $("ratingMy");
  const ratingCount = $("ratingCount");
  const ratingSat = $("ratingSat");
  const ratingTeam = $("ratingTeam");
  const ratingTeamSat = $("ratingTeamSat");
  const ratingEmpty = $("ratingEmpty");
  if (ratingSummary) {
    if (ratingMy) ratingMy.textContent = ratingSummary.myRating != null ? ratingSummary.myRating : "—";
    if (ratingCount) ratingCount.textContent = ratingSummary.ratingCount != null ? ratingSummary.ratingCount : "—";
    if (ratingSat) ratingSat.textContent = ratingSummary.satisfiedPct != null ? ratingSummary.satisfiedPct + "%" : "—";
    if (ratingTeam) ratingTeam.textContent = ratingSummary.teamRating != null ? "★ " + ratingSummary.teamRating : "—";
    if (ratingTeamSat) ratingTeamSat.textContent = ratingSummary.teamSatisfiedPct != null ? ratingSummary.teamSatisfiedPct + "%" : "—";
    if (ratingEmpty) ratingEmpty.style.display = "none";
  } else {
    if (ratingEmpty) ratingEmpty.style.display = "block";
  }

  const rcCount = $("ratingChangeCount");
  if (rcCount) rcCount.textContent = ratingChanges.length;
  const rcBody = $("ratingChangesBody");
  if (rcBody) {
    rcBody.innerHTML = ratingChanges.slice(0, 50).map((c) => `
      <tr>
        <td>${esc(c.field)}</td>
        <td>${esc(c.from)}</td>
        <td>${esc(c.to)}</td>
        <td><time datetime="${new Date(c.at).toISOString()}">${esc(timeAgo(c.at))}</time></td>
      </tr>`).join("");
  }
  const rcEmpty = $("ratingChangesEmpty");
  if (rcEmpty) rcEmpty.style.display = ratingChanges.length ? "none" : "block";

  const notifCount = $("notifCount");
  const filteredNotifs = notifFilter === "all" ? notifications : notifications.filter((n) => n.category === notifFilter);
  if (notifCount) notifCount.textContent = filteredNotifs.length;
  const notifBody = $("notifBody");
  if (notifBody) {
    notifBody.innerHTML = filteredNotifs.slice(0, 100).map((n) => `
      <tr>
        <td><span class="badge tracked">${esc(n.category || "")}</span></td>
        <td>${esc(n.title || "")}</td>
        <td class="msg">${esc(n.text || "")}</td>
        <td><time datetime="${new Date(n.at).toISOString()}">${esc(timeAgo(n.at))}</time></td>
      </tr>`).join("");
  }
  const notifEmpty = $("notifEmpty");
  if (notifEmpty) notifEmpty.style.display = filteredNotifs.length ? "none" : "block";

  document.querySelectorAll("[data-notif]").forEach((el) => {
    el.onclick = () => {
      document.querySelectorAll("[data-notif]").forEach((b) => b.classList.remove("on"));
      el.classList.add("on");
      notifFilter = el.dataset.notif;
      render();
    };
  });

  const bellCount = $("bellCount");
  if (bellCount) bellCount.textContent = notifications.filter((n) => n.read !== true).length;
  const overviewLastScan = $("overviewLastScan");
  if (overviewLastScan) {
    overviewLastScan.textContent = lastScanSummary?.finishedAt
      ? "Last scan: " + timeAgo(lastScanSummary.finishedAt) + " ago"
      : lastDeepScanAt
        ? "Last scan: " + timeAgo(lastDeepScanAt) + " ago"
        : "No scan yet";
  }
  // Update filter button counts
  const totalCount = Object.keys(tickets).length;
  const starredCount = Object.values(tickets).filter((t) => t.starred).length;
  const filterCounts = {
    all: totalCount,
    starred: starredCount,
    waiting: waiting.length,
    pending: pending.length,
    missed: missed.length,
    snoozed: snoozed.length,
    late: late.length
  };
  document.querySelectorAll(".filters .filter[data-filter]").forEach((btn) => {
    const key = btn.dataset.filter;
    const baseLabel = btn.dataset.baseLabel || btn.textContent.replace(/\s*\(\d+\)\s*$/, "").trim();
    if (!btn.dataset.baseLabel) btn.dataset.baseLabel = baseLabel;
    const count = filterCounts[key];
    btn.textContent = count != null ? `${baseLabel} (${count})` : baseLabel;
  });
  $("repliesBody").innerHTML = replyEvents.map((reply) => `
    <tr>
      <td><span class="customer-name">${icon("reply")}${esc(reply.name || "Customer")}</span></td>
      <td><a class="tid" href="${PANEL_BASE}?ticket_id=${esc(reply.id)}" target="_blank">#${esc(reply.id)}</a></td>
      <td class="msg">${esc(reply.text || "")}</td>
      <td><time datetime="${new Date(reply.at).toISOString()}" title="${new Date(reply.at).toLocaleString()}">${esc(timeAgo(reply.at))}</time></td>
    </tr>`).join("");
  $("repliesEmpty").style.display = replyEvents.length ? "none" : "block";

  // Date filter count badge
  const dateFilterCountEl = $("dateFilterCount");
  if (dateFilterCountEl) {
    const df = $("dateFilter")?.value;
    if (df) {
      let c = 0;
      for (const tk of Object.values(tickets)) {
        const ts = ticketActivityAt(tk);
        if (ts && localDateKey(ts) === df) c++;
      }
      dateFilterCountEl.textContent = c;
      dateFilterCountEl.style.display = "inline-block";
    } else {
      dateFilterCountEl.style.display = "none";
    }
  }

  // Greeting + username
  const greetEl = $("greeting");
  const brandSub = $("brandSub");
  const hour = new Date().getHours();
  let greet = "Good night";
  if (hour >= 5 && hour < 12) greet = "Good morning";
  else if (hour >= 12 && hour < 17) greet = "Good afternoon";
  else if (hour >= 17 && hour < 21) greet = "Good evening";
  if (greetEl) greetEl.textContent = greet + (settings.agentName ? ", " + settings.agentName : "");
  if (brandSub) brandSub.textContent = "Packzy support - MD SWAMPOD SARKAR" + (settings.agentName ? " - " + settings.agentName : "");

  const missedById = new Map(missed.map((t) => [String(t.id), t]));
  const pendingById = new Map(pending.map((t) => [String(t.id), t]));
  const waitingById = new Map(waiting.map((t) => [String(t.id), t]));
  const snoozedIds = new Set(snoozed.map((t) => String(t.id)));
  const lateById = new Map(late.map((t) => [String(t.id), t]));
  let rows = Object.entries(tickets).map(([key, savedTicket]) => {
    const id = String(savedTicket.id ?? key);
    const ticket = { ...savedTicket, id };
    let status = "tracked";
    let item = ticket;
    if (lateById.has(id)) { status = "late"; item = { ...ticket, ...lateById.get(id), warningHours }; }
    else if (missedById.has(id)) {
      status = snoozedIds.has(id) ? "snoozed" : "missed";
      item = { ...ticket, ...missedById.get(id), warningHours };
    } else if (pendingById.has(id)) { status = "pending"; item = { ...ticket, ...pendingById.get(id), warningHours }; }
    else if (waitingById.has(id)) { status = "waiting"; item = { ...ticket, ...waitingById.get(id), warningHours }; }
    else if ((ticket.lastAgentAt && ticket.lastCustomerAt && ticket.lastAgentAt >= ticket.lastCustomerAt) ||
      ticket.resolvedForCustomerAt === ticket.lastCustomerAt) {
      status = "answered";
    }
    const lastReplyAt = ticketActivityAt(ticket);
    return { html: rowHTML(item, status), status, starred: ticket.starred === true, lastReplyAt };
  }).filter((row) => {
    if (filter === "starred" && !row.starred) return false;
    if (filter === "all") { /* date filter applied below */ }
    if (filter !== "all" && filter !== "starred" && row.status !== filter) return false;
    const df = $("dateFilter")?.value;
    if (df && localDateKey(row.lastReplyAt) !== df) return false;
    return true;
  }).map((row) => row.html);

  if (query) {
    rows = rows.filter((html) => html.toLowerCase().includes(query));
  }

  $("tbody").innerHTML = rows.join("");
  $("empty").style.display = rows.length ? "none" : "block";
  if (!rows.length) {
    const total = Object.keys(tickets).length;
    $("empty").textContent = total
      ? filter === "starred"
        ? "No starred tickets - press Star on a ticket."
        : "No tickets in this filter."
      : "No data - run a Deep Scan from the panel first.";
  }

  // per-agent stats
  const agentCounts = {};
  missed.forEach((t) => {
    const a = t.assignedTo || "(unassigned)";
    agentCounts[a] = (agentCounts[a] || 0) + 1;
  });
  const statsEl = $("agentStats");
  if (statsEl) {
    const entries = Object.entries(agentCounts).sort((a, b) => b[1] - a[1]);
    statsEl.innerHTML = entries.length
      ? `<span class="agent-stats-title">${icon("alert")} Missed by agent:</span> ` + entries.map(([a, n]) => `<span class="agent-chip">${esc(a)} <b>${n}</b></span>`).join(" ")
      : "";
  }

  document.querySelectorAll("[data-done]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.done;
      const t = tickets[id] || { id };
      t.answered = true;
      t.missed = false;
      t.resolvedForCustomerAt = t.lastCustomerAt || null;
      delete t.lastMissedAlertFor;
      delete t.lastLateAlertCustomerAt;
      delete t.snoozeUntil;
      delete t.snoozedAt;
      tickets[id] = t;
      await chrome.storage.local.set({ tickets });
      render();
    };
  });

  document.querySelectorAll("[data-snooze]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.snooze;
      const t = tickets[id] || { id };
      t.snoozeUntil = Date.now() + 12 * 3600000;
      t.snoozedAt = Date.now();
      tickets[id] = t;
      await chrome.storage.local.set({ tickets });
      render();
    };
  });

  document.querySelectorAll("[data-unsnooze]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.unsnooze;
      if (tickets[id]) { delete tickets[id].snoozeUntil; delete tickets[id].snoozedAt; }
      await chrome.storage.local.set({ tickets });
      render();
    };
  });

  document.querySelectorAll("[data-star]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.star;
      if (!tickets[id]) return;
      tickets[id].starred = !tickets[id].starred;
      await chrome.storage.local.set({ tickets });
      render();
    };
  });
}

function exportCSV() {
  const { missed, snoozed, late, warningHours } = compute();
  const rows = [["Status", "Ticket ID", "Name", "Category", "Priority", "Wait / response(h)", "Rule", "Assigned", "Last Message"]]
    .concat(missed.map((t) => ["Missed - no agent reply", "#" + t.id, t.name || "", t.category || "", t.priority || "", t.waitH ?? "", "Immediate", t.assignedTo || "", t.preview || ""]))
    .concat(late.map((t) => [`Agent reply over ${warningHours}h`, "#" + t.id, t.name || "", t.category || "", t.priority || "", t.responseDelayH ?? "", `${warningHours}h warning`, t.assignedTo || "", t.lastCustomerText || t.preview || ""]))
    .concat(snoozed.map((t) => ["Snoozed", "#" + t.id, t.name || "", t.category || "", t.priority || "", t.waitH ?? "", "", t.assignedTo || "", t.preview || ""]));

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, "'")}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `missed-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- events ----------------
document.querySelectorAll(".filter").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    filter = btn.dataset.filter;
    render();
  };
});

$("search").addEventListener("input", (e) => {
  query = e.target.value.toLowerCase().trim();
  render();
});

  const dateFilterEl = $("dateFilter");
  if (dateFilterEl) dateFilterEl.addEventListener("change", () => render());

$("export").onclick = exportCSV;
$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  const label = button.querySelector("span");
  if (button.disabled) return;
  button.disabled = true;
  if (label) label.textContent = "Refreshing…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "MRT_TRIGGER_AUTO_SCAN", force: true });
    if (!response?.ok) throw new Error(response?.error || "Could not start ticket refresh.");
    await load();
    if (label) label.textContent = "Scan started";
    setTimeout(() => { if (label) label.textContent = "Refresh"; }, 1800);
  } catch (error) {
    console.error("[MRT Dashboard] Could not refresh ticket status:", error);
    if (label) label.textContent = "Refresh failed";
    setTimeout(() => { if (label) label.textContent = "Refresh"; }, 2500);
  } finally {
    button.disabled = false;
  }
});
$("autoMyTicketsScan").addEventListener("change", async (event) => {
  const { settings: savedSettings = {} } = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...savedSettings, autoMyTicketsScan: event.target.checked };
  await chrome.storage.local.set({ settings });
  updateAutoScanStatus();
  if (event.target.checked) {
    try { chrome.runtime.sendMessage({ type: "MRT_TRIGGER_AUTO_SCAN" }); } catch (e) {}
  }
});

$("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

$("bell").onclick = () => {
  const popup = $("notifPopup");
  if (popup) {
    // mark all as read
    let changed = false;
    notifications = notifications.map((n) => {
      if (n.read !== true) { changed = true; return { ...n, read: true }; }
      return n;
    });
    if (changed) chrome.storage.local.set({ notifications }).catch(() => {});
    const bellCount = $("bellCount");
    if (bellCount) bellCount.textContent = "0";
    popup.onclick = (e) => { if (e.target === popup) popup.hidden = true; };
    popup.hidden = false;
    renderNotifPopup();
  }
};
const popupClose = $("notifPopupClose");
if (popupClose) popupClose.onclick = () => { const p = $("notifPopup"); if (p) p.hidden = true; };
const markAllRead = $("markAllRead");
if (markAllRead) markAllRead.onclick = () => {
  let changed = false;
  notifications = notifications.map((n) => { if (n.read !== true) { changed = true; return { ...n, read: true }; } return n; });
  if (changed) chrome.storage.local.set({ notifications }).catch(() => {});
  const bellCount = $("bellCount");
  if (bellCount) bellCount.textContent = "0";
  render();
  renderNotifPopup();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const p = $("notifPopup");
    if (p) p.hidden = true;
  }
});
document.querySelectorAll("[data-popup-notif]").forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll("[data-popup-notif]").forEach((b) => b.classList.remove("on"));
    el.classList.add("on");
    popupNotifFilter = el.dataset.popupNotif;
    renderNotifPopup();
  };
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.tickets) tickets = ch.tickets.newValue || {};
  if (ch.customerReplies) customerReplyEvents = Array.isArray(ch.customerReplies.newValue) ? ch.customerReplies.newValue : [];
  if (ch.settings) settings = { ...DEFAULTS, ...(ch.settings.newValue || {}) };
  if (ch.lastDeepScanAt) lastDeepScanAt = ch.lastDeepScanAt.newValue || 0;
  if (ch.lastScanSummary) lastScanSummary = ch.lastScanSummary.newValue || null;
  if (ch.ratingSummary) ratingSummary = ch.ratingSummary.newValue || null;
  if (ch.ratingChanges) ratingChanges = Array.isArray(ch.ratingChanges.newValue) ? ch.ratingChanges.newValue : [];
  if (ch.notifications) notifications = Array.isArray(ch.notifications.newValue) ? ch.notifications.newValue : [];
  if (ch.firebaseSyncStatus) firebaseSyncStatus = ch.firebaseSyncStatus.newValue || null;
  if (ch.settings || ch.lastAutoMyTicketsScanAt) {
    chrome.storage.local.get("lastAutoMyTicketsScanAt").then((value) => {
      $("autoMyTicketsScan").checked = settings.autoMyTicketsScan === true;
      updateAutoScanStatus(value.lastAutoMyTicketsScanAt || 0);
    });
  }
  try { render(); } catch (e) { console.error("[MRT Dashboard] render error:", e); }
  if (ch.firebaseSyncStatus || ch.settings) renderLeaderboard();
});

document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.remove("on"));
    el.classList.add("on");
    const view = el.dataset.view;
    document.body.dataset.view = view;
    document.querySelectorAll("section[data-view]").forEach((sec) => {
      const views = (sec.dataset.view || "").split(/\s+/);
      sec.style.display = views.includes(view) ? "block" : "none";
    });
  });
});

const refreshLeaderboard = $("refreshLeaderboard");
if (refreshLeaderboard) refreshLeaderboard.addEventListener("click", loadLeaderboard);

const initialView = new URLSearchParams(location.search).get("welcome") === "1" ? "leaderboard" : "overview";
const initialNav = document.querySelector(`.nav-item[data-view="${initialView}"]`)
  || document.querySelector(".nav-item.on[data-view]");
if (initialNav) initialNav.click();

function renderNotifPopup() {
  const body = $("notifPopupBody");
  if (!body) return;
  const filtered = popupNotifFilter === "all" ? notifications : notifications.filter((n) => n.category === popupNotifFilter);
  body.innerHTML = filtered.slice(0, 100).map((n) => `
    <div class="notif-popup-item">
      <div class="cat">${esc(n.category || "")}</div>
      <div><strong>${esc(n.title || "")}</strong></div>
      <div class="msg">${esc(n.text || "")}</div>
      <div class="when">${esc(timeAgo(n.at))}</div>
    </div>`).join("") || '<div class="empty">No notifications.</div>';
}

setInterval(load, 1000);
setInterval(loadLeaderboard, 30_000);
load();
loadLeaderboard();
