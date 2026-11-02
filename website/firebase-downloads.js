(() => {
  const API_KEY = "AIzaSyAsCuNWtsIEX2mvXxpdVWvWS-J8jwFH6hM";
  const DATABASE_URL = "https://steadfast-leaderbord-default-rtdb.asia-southeast1.firebasedatabase.app";
  const SESSION_KEY = "sfc-download-counter-auth";
  const countElement = document.getElementById("download-count");
  let session = null;
  let sessionPromise = null;

  function setCountMessage(message) {
    if (countElement) countElement.textContent = message;
  }

  async function readJson(response) {
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("Firebase returned an invalid response.");
      }
    }
    if (!response.ok) {
      const details = result?.error?.message || result?.error || `HTTP ${response.status}`;
      throw new Error(`Firebase download counter failed: ${details}`);
    }
    return result;
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getSession() {
    if (session?.idToken && session.expiresAt > Date.now() + 60_000) return session;
    if (sessionPromise) return sessionPromise;

    sessionPromise = (async () => {
      let saved = null;
      try {
        saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      } catch (error) {
        console.warn("[SFC Website] Could not read Firebase session storage:", error);
      }

      const refreshing = !!saved?.refreshToken;
      const endpoint = refreshing
        ? `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`
        : `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: refreshing
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : { "Content-Type": "application/json" },
        body: refreshing
          ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken })
          : JSON.stringify({ returnSecureToken: true })
      });
      const result = await readJson(response);
      const expiresIn = Number(result.expiresIn || result.expires_in);
      session = {
        idToken: result.idToken || result.id_token,
        refreshToken: result.refreshToken || result.refresh_token || saved?.refreshToken,
        uid: result.localId || result.user_id || saved?.uid,
        expiresAt: Date.now() + expiresIn * 1000
      };
      if (!session.idToken || !session.refreshToken || !session.uid || !Number.isFinite(expiresIn)) {
        throw new Error("Firebase returned an incomplete anonymous session.");
      }
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          refreshToken: session.refreshToken,
          uid: session.uid,
          expiresAt: session.expiresAt
        }));
      } catch (error) {
        console.warn("[SFC Website] Could not save Firebase session:", error);
      }
      return session;
    })().finally(() => {
      sessionPromise = null;
    });

    return sessionPromise;
  }

  async function databaseRequest(path, token, options = {}) {
    const url = new URL(`${DATABASE_URL}/${path}.json`);
    url.searchParams.set("auth", token);
    return readJson(await fetchWithTimeout(url, {
      ...options,
      headers: { ...(options.headers || {}) }
    }));
  }

  function countEvents(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
    return Object.values(data).reduce((total, userEvents) => {
      if (!userEvents || typeof userEvents !== "object" || Array.isArray(userEvents)) return total;
      return total + Object.keys(userEvents).length;
    }, 0);
  }

  async function refreshCount() {
    const { idToken } = await getSession();
    const events = await databaseRequest("websiteDownloadEvents", idToken);
    const total = countEvents(events);
    if (countElement) {
      countElement.innerHTML = `ডাউনলোড বাটনে মোট click: <strong>${total.toLocaleString()}</strong>`;
    }
  }

  async function recordDownload() {
    const currentSession = await getSession();
    const eventId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await databaseRequest(
      `websiteDownloadEvents/${encodeURIComponent(currentSession.uid)}/${eventId}`,
      currentSession.idToken,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Date.now())
      }
    );
    await refreshCount();
  }

  document.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a[download]");
    if (!link || link.dataset.counterReplay === "true") return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      recordDownload().catch((error) => console.error("[SFC Website] Download click was not counted:", error));
      return;
    }

    event.preventDefault();
    try {
      await recordDownload();
    } catch (error) {
      console.error("[SFC Website] Download click was not counted:", error);
      setCountMessage("Download count এখন পাওয়া যাচ্ছে না; ডাউনলোড চালু আছে।");
    } finally {
      link.dataset.counterReplay = "true";
      link.click();
      delete link.dataset.counterReplay;
    }
  });

  refreshCount().catch((error) => {
    console.error("[SFC Website] Could not load download count:", error);
    setCountMessage("Download count এখন পাওয়া যাচ্ছে না।");
  });
})();
