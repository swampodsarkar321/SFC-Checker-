# SFC TICKET CHECKER

Created by **MD SWAMPOD SARKAR**.

Support assistant for the Packzy admin panel (`https://dash.packzy.com/admin/support`): missed replies, late-response warnings, snooze, dashboard.

## Install

1. `chrome://extensions` -> **Developer mode** ON
2. **Load unpacked** -> `missed-reply-extension` folder
3. On first install, the Dashboard opens and the extension creates/syncs its Firebase account.
4. Open your Packzy **My tickets/Mine** list and run a Deep Scan once. The extension detects the assigned agent name and publishes stats automatically.
5. Open the Packzy support tab; click the extension icon to toggle the tracker panel.

## Features

### Missed Reply
After the reply-wait threshold passes with no later agent reply, the ticket is counted as missed - with ticket ID, wait time, name and last message. A customer reply from yesterday therefore appears as missed once it is older than the configured threshold (12 hours by default). Deep Scan checks the conversation messages; list activity or an unread count alone is not treated as an agent reply.

### Late Agent Reply
If the agent takes longer than the configured time, a late-reply warning shows in the dashboard/panel and a desktop notification fires.

Reply-wait threshold: 1-168 hours (default 12). Before the threshold the ticket shows as Waiting; after it, Missed.

### Assigned ticket reminder
The extension checks your assigned unanswered tickets and sends a desktop alert after 10 minutes by default, timed from the later of the customer message or the ticket's assignment to you. High priority tickets use a 5-minute threshold and Urgent tickets use 1 minute by default; Normal and Low use the main setting. Adjust these in **Settings → Assigned ticket reminder** (1-1440 minutes). Each customer message/assignment triggers at most one reminder; when an agent replies, it no longer appears as pending. The reminder requires the extension to identify your agent name from the Packzy My tickets/Mine scan.

### Daily summary
By default, the extension sends one notification each day at 9:00 AM local time with counts of tickets that had customer or agent replies today, the number of tickets still awaiting a reply, and the average recorded response time. Change the time or disable it under **Settings → Daily summary**. Quiet hours still apply.

### Snooze / Waiting Customer
For tickets waiting on a customer reply, click **Snooze 12h**. Remove from the snoozed list with X. Auto-unsnoozes when the customer sends a new message.

### Sound alert
Desktop notifications for new missed replies and new customer replies.

### Deep Scan (no page reload)
1. Switch to the "Mine" tab
2. Click **Load older tickets** to load all tickets
3. The extension opens each row in-place (no page reload)

Live progress: `87/200 . 43% . 113 left`

### Dashboard
The **Dashboard** button opens a full page with:
- Missed / Snoozed / Tracked / Late cards
- Tickets filter for assigned-to-you tickets with no agent reply after the configured reminder threshold
- Agent leaderboard ranked by rating, then satisfaction percentage, then total tracked tickets
- Unified worklist of all tracked tickets; snooze/unsnooze and star from each row; Starred filter
- Last scan time, listed/checked/skipped/failed counts and whether pagination completed
- New customer reply notification history: customer name, message, time ago
- Search + filter
- Table: status, ticket link, name, category, priority, wait/response time, message
- CSV export, snooze/unsnooze
- The date filter uses each ticket's latest recorded activity (customer or agent message/list activity) in your computer's local date; it works together with ticket status and Starred filters.

Use the Dashboard **Refresh** button to re-check currently missed/pending tickets against the Packzy My tickets conversations, even when automatic scanning is off. An agent reply removes the ticket from Missed/Pending once the updated conversation is read. The **Done** action resolves the current customer message only; a later customer reply makes the ticket active again.

### Auto My tickets scan
Toggle **My tickets auto-scan** on the Dashboard to scan every 5 minutes. Tickets whose conversations have not been scanned yet are checked on the first pass, even without an unread badge. After that, tickets with new list activity or unread messages are opened; unchanged tickets are skipped each cycle. A new customer reply without an agent reply triggers a desktop notification and appears in the reply history. Toggle off also disables the alarm.

Manual **Deep Scan** paginates all My tickets/Mine tickets and checks every conversation even if marked answered. It waits for each page to finish loading, stops and marks coverage incomplete if pagination stalls, confirms the selected ticket conversation changed before reading it, and reports tickets it could not read. You can switch to another browser tab while it runs; the scan stays in the Packzy tab where it started and does not activate or navigate another tab. Keep that Packzy tab open and do not reload it; Chrome may slow work in background tabs. Quick unread and light scans pause while a Deep Scan is running so they cannot interrupt its ticket checks. Opening another Packzy tab will not open its panel, reset its scan, or start a competing scan. Ticket results remain shared with the Dashboard, but a scan of one scope will not delete tracked tickets missing from that scope. Old ticket records are cleaned up after seven days.

### Firebase sync and leaderboard
The Firebase Realtime Database URL is already built into the extension; users do not need to enter any Firebase configuration. The extension syncs automatically after installation. The Firebase project owner must enable **Authentication → Sign-in method → Anonymous** once in Firebase Console. If the extension reports `CONFIGURATION_NOT_FOUND`, Anonymous Authentication has not yet been enabled for the project.

Create a Realtime Database and use these rules to keep each agent's extension data private while allowing signed-in users to read the leaderboard and update only their own row:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "leaderboard": {
      ".read": "auth != null",
      "$uid": {
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "websiteDownloadEvents": {
      ".read": "auth != null",
      "$uid": {
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The extension syncs its local settings, tickets, scan results, and notification/rating history to that anonymous account. On the Packzy **My tickets/Mine** scope, it detects the signed-in agent from the ticket's Assigned field and saves that name automatically. The leaderboard publishes only the agent name, Packzy rating, satisfaction percentage, and tracked-ticket count; other agents' ticket/customer data is not published. Entries rank by rating first, satisfaction percentage next, and ticket count as the final tie-breaker. Leaderboard data refreshes every 30 seconds and displays a single row for names that match ignoring case and repeated spaces; if multiple installations use the same agent name, the most recently updated row is shown. Anonymous accounts are installation-specific, so reinstalling the extension or using another browser creates a separate account in Firebase, although duplicate matching names are collapsed in the leaderboard display.

The website counts download-button clicks in `websiteDownloadEvents` using Firebase Anonymous Authentication. The counter aggregates event records; it counts clicks, not confirmed completed downloads. Apply the rules above to the same Realtime Database used by the extension for the count to load and accept events.

## Settings

| Setting | Default |
|---|---|
| Agent name | (empty) |
| Only mine | ON |
| Sound | ON |
| Auto My tickets scan | OFF (Dashboard toggle) |
| Reply wait threshold | 12 hours (1-168) |
| Assigned ticket reminder | 10 minutes (1-1440) |
| Light scan | 90 sec |
| Desktop notification type | All alerts |
| Quiet hours | Off (local time, default 22:00-08:00) |

During quiet hours desktop notifications are not sent and are not replayed later. Notification history prevents duplicate events from showing multiple times.

## Selectors

- Row: `button.ticket-item` -> `.ticket-item__id`, `.ticket-item__name`, `time[datetime]`, `.ticket-item__preview`, `.ticket-item__unread`, `[class*="priority-"]`
- Message: `article.msg.msg--inbound` (customer) / `.msg--outbound` (agent), `.msg__text`, `time[datetime]`
- Facts: `.fact__label` -> `.fact__value` (Assigned / Category)
- Pagination: `button.load-more__button`
- Mine tab: `.scope-pill` (`scope-pill--on`)
