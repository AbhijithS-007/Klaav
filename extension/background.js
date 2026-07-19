const SHARED_SECRET = "my-secret-token";
const WS_URL = "ws://127.0.0.1:8765";
const STORAGE_KEY = "tabCreatedTimestamps";

let socket = null;

// Feature detection for browser ID. Service workers do not have access to DOM/document.
function getBrowserId() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) {
    return "edge";
  } else if (navigator.brave !== undefined) {
    return "brave";
  } else if (ua.includes("OPR/") || ua.includes("Opera/")) {
    return "opera";
  } else if (ua.includes("Vivaldi/")) {
    return "vivaldi";
  } else if (ua.includes("Chrome/")) {
    // Both Edge and Brave include Chrome in their UA, but we filtered them out above
    return "chrome";
  }
  console.log("Unrecognized Chromium variant. UA:", navigator.userAgent, "Vendor:", navigator.vendor);
  return "chromium";
}

const BROWSER_ID = getBrowserId();

function isTrackableUrl(url) {
  if (!url) return false;
  return !url.startsWith("chrome://") && 
         !url.startsWith("edge://") && 
         !url.startsWith("about:") && 
         !url.startsWith("brave://") &&
         !url.startsWith("chrome-extension://");
}

// -------------------------------------------------------------------
// Timestamp storage helpers (persisted via chrome.storage.local)
// -------------------------------------------------------------------
async function getTimestamps() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function setTimestamps(timestamps) {
  await chrome.storage.local.set({ [STORAGE_KEY]: timestamps });
}

/**
 * On startup, ensure every existing tab has a stored timestamp.
 * Pre-existing tabs (from before tracking started) get synthetic
 * timestamps based on their tab-strip index, so they preserve their
 * relative order among themselves while always sorting before any
 * newly created tab.
 */
async function initializeTimestamps() {
  const timestamps = await getTimestamps();
  const tabs = await chrome.tabs.query({});
  let changed = false;

  // Use a base time far in the past so pre-existing tabs sort before
  // any real tab created after this point.
  const BASE_TIME = Date.now() - (tabs.length + 1) * 1000;

  for (const tab of tabs) {
    const key = String(tab.id);
    if (timestamps[key] === undefined) {
      // Assign synthetic timestamp: earlier index → earlier time
      timestamps[key] = BASE_TIME + tab.index * 1000;
      changed = true;
    }
  }

  if (changed) {
    await setTimestamps(timestamps);
  }
}

// -------------------------------------------------------------------
// Tab snapshot (now includes created_at)
// -------------------------------------------------------------------
async function getTabsSnapshot() {
  const tabs = await chrome.tabs.query({});
  const timestamps = await getTimestamps();

  return tabs.filter(t => isTrackableUrl(t.url)).map(t => ({
    tab_id: t.id,
    window_id: t.windowId,
    title: t.title || "",
    url: t.url || "",
    active: t.active,
    favIconUrl: t.favIconUrl || "",
    created_at: timestamps[String(t.id)] || 0
  }));
}

// -------------------------------------------------------------------
// WebSocket connection
// -------------------------------------------------------------------
function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(WS_URL);

  socket.onopen = async () => {
    console.log("WebSocket connected to Klaav backend as", BROWSER_ID);
    const tabs = await getTabsSnapshot();
    socket.send(JSON.stringify({
      type: "hello",
      browser: BROWSER_ID,
      token: SHARED_SECRET,
      tabs: tabs
    }));
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "activate-tab") {
        await chrome.tabs.update(msg.tab_id, { active: true });
        await chrome.windows.update(msg.window_id, { focused: true });
      } else if (msg.type === "close-tab") {
        await chrome.tabs.remove(msg.tab_id);
      }
    } catch (e) {
      console.error("Error processing message:", e);
    }
  };

  socket.onclose = () => {
    console.log("WebSocket connection closed. Will reconnect on next keepalive.");
    socket = null;
  };

  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

// -------------------------------------------------------------------
// Tab event handlers
// -------------------------------------------------------------------

// Record timestamp on creation
chrome.tabs.onCreated.addListener(async (tab) => {
  const timestamps = await getTimestamps();
  timestamps[String(tab.id)] = Date.now();
  await setTimestamps(timestamps);
  sendTabsUpdate();
});

// Clean up timestamp on removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const timestamps = await getTimestamps();
  delete timestamps[String(tabId)];
  await setTimestamps(timestamps);
  sendTabsUpdate();
});

// Debounce tabs updates to avoid spamming the websocket on multi-tab events
let updateTimeout = null;
async function sendTabsUpdate() {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = setTimeout(async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const tabs = await getTabsSnapshot();
      socket.send(JSON.stringify({
        type: "tabs-update",
        tabs: tabs
      }));
    }
  }, 100);
}

// These events don't need timestamp changes, just send the update
chrome.tabs.onUpdated.addListener(sendTabsUpdate);
chrome.tabs.onActivated.addListener(sendTabsUpdate);
chrome.tabs.onMoved.addListener(sendTabsUpdate);

// Keepalive via alarms to ensure the service worker stays alive and connected
// MV3 kills idle workers after 30s. Triggering an alarm every ~20s prevents this.
chrome.alarms.create("keepalive", { periodInMinutes: 0.33 }); 
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Also use this as a heartbeat to reconnect if needed
    connect();
  }
});

// Initialize timestamps for pre-existing tabs, then connect
initializeTimestamps().then(() => {
  connect();
});
