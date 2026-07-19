const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let tabsData = [];
let selectedTabId = null;
let selectedBrowser = null;
let selectedIndex = -1;
let groupByBrowser = false;
let pinnedUrls = [];

window.addEventListener("DOMContentLoaded", async () => {
  console.log("Loading state mounted/visible");
  const tabsViewEl = document.getElementById("tabs-view");
  const panelEl = document.getElementById("panel");
  const settingsTrigger = document.getElementById("settings-trigger");
  const settingsPanel = document.getElementById("settings-panel");
  const groupBrowserCb = document.getElementById("group-browser-cb");
  const themeSelect = document.getElementById("theme-select");

  let currentTheme = "glass";

  // Load persisted settings
  try {
    const settings = await invoke("load_settings");
    groupByBrowser = settings.groupByBrowser;
    currentTheme = settings.theme;
    pinnedUrls = settings.pinnedUrls || [];
    
    groupBrowserCb.checked = groupByBrowser;
    themeSelect.value = currentTheme;
    document.documentElement.className = currentTheme === "glass" ? "" : currentTheme;
  } catch (err) {
    console.error("Failed to load settings:", err);
  }

  // ---------------------------------------------------------------
  // Settings toggle
  // ---------------------------------------------------------------
  settingsTrigger.addEventListener("click", () => {
    const isOpen = settingsPanel.classList.toggle("open");
    invoke("report_settings_open", { isOpen }).catch(e => console.error(e));
  });

  async function saveSettings() {
    try {
      await invoke("save_settings", { settings: { groupByBrowser, theme: currentTheme, pinnedUrls } });
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }

  groupBrowserCb.addEventListener("change", (e) => {
    groupByBrowser = e.target.checked;
    saveSettings();
    sortTabsData();
    renderTabs(true);
  });

  themeSelect.addEventListener("change", (e) => {
    currentTheme = e.target.value;
    document.documentElement.className = currentTheme === "glass" ? "" : currentTheme;
    saveSettings();
  });

  // ---------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (tabsData.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Clamp to bounds
      selectedIndex = Math.min(selectedIndex + 1, tabsData.length - 1);
      updateSelectionState(selectedIndex);
      renderTabs();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // Clamp to bounds
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelectionState(selectedIndex);
      renderTabs();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < tabsData.length) {
        const tab = tabsData[selectedIndex];
        invoke("switch_tab", {
          browser: tab.browser,
          tabId: tab.tab_id,
          windowId: tab.window_id
        }).catch(err => console.error("Failed to switch tab:", err));
      }
    }
  });

  // ---------------------------------------------------------------
  // Mouse wheel scrolling
  // ---------------------------------------------------------------
  panelEl.addEventListener("wheel", (e) => {
    if (tabsData.length === 0) return;
    e.preventDefault();
    if (e.deltaY > 0) {
      selectedIndex = Math.min(selectedIndex + 1, tabsData.length - 1);
    } else {
      selectedIndex = Math.max(selectedIndex - 1, 0);
    }
    updateSelectionState(selectedIndex);
    renderTabs();
  });

  // ---------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------
  function updateSelectionState(index) {
    if (index >= 0 && index < tabsData.length) {
      selectedIndex = index;
      selectedTabId = tabsData[index].tab_id;
      selectedBrowser = tabsData[index].browser;
    }
  }

  function sortTabsData() {
    if (groupByBrowser) {
      tabsData.sort((a, b) => {
        if (a.browser !== b.browser) return a.browser.localeCompare(b.browser);
        return (a.created_at || 0) - (b.created_at || 0);
      });
    } else {
      tabsData.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    }
  }

  // ---------------------------------------------------------------
  // tabs-updated listener
  // ---------------------------------------------------------------
  listen("tabs-updated", (event) => {
    const loader = document.getElementById("loading-state");
    if (loader && loader.style.display !== "none") {
      console.log("Loading state hidden (tabs arrived)");
      loader.style.display = "none";
    }
    tabsData = event.payload || [];

    sortTabsData();

    if (tabsData.length === 0) {
      selectedIndex = -1;
      selectedTabId = null;
      selectedBrowser = null;
    } else {
      // Restore selection by ID/browser across re-renders
      if (selectedTabId !== null && selectedBrowser !== null) {
        const idx = tabsData.findIndex(
          t => t.tab_id === selectedTabId && t.browser === selectedBrowser
        );
        if (idx !== -1) {
          selectedIndex = idx;
        } else {
          selectedIndex = -1;
          selectedTabId = null;
          selectedBrowser = null;
        }
      }

      // Default to the currently-active browser tab if nothing selected
      if (selectedIndex === -1) {
        const activeIdx = tabsData.findIndex(t => t.active);
        selectedIndex = activeIdx !== -1 ? activeIdx : 0;
        updateSelectionState(selectedIndex);
      }
    }

    renderPinnedRow();
    renderTabs(true);
  });

  // ---------------------------------------------------------------
  // renderPinnedRow
  // ---------------------------------------------------------------
  function renderPinnedRow() {
    const pinnedRowEl = document.getElementById("pinned-row");
    if (!pinnedRowEl) return;
    
    pinnedRowEl.innerHTML = "";
    
    pinnedUrls.forEach(url => {
      const chipEl = document.createElement("div");
      
      // Check if this URL is currently open
      const liveTab = tabsData.find(t => t.url === url);
      
      chipEl.className = liveTab ? "pinned-chip" : "pinned-chip offline";
      chipEl.title = liveTab ? (liveTab.title || url) : url;
      
      if (liveTab) {
        const dotEl = document.createElement("div");
        dotEl.className = `tab-dot ${liveTab.browser}`;
        chipEl.appendChild(dotEl);
        
        chipEl.addEventListener("click", () => {
          invoke("switch_tab", {
            browser: liveTab.browser,
            tabId: liveTab.tab_id,
            windowId: liveTab.window_id
          }).catch(err => console.error("Failed to switch tab:", err));
        });
      } else {
        const imgEl = document.createElement("img");
        imgEl.className = "favicon";
        try {
          const hostname = new URL(url).hostname;
          imgEl.src = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
        } catch(e) {
          // If URL parsing fails, just use generic favicon
          imgEl.src = `https://www.google.com/s2/favicons?domain=example.com&sz=32`;
        }
        chipEl.appendChild(imgEl);
      }
      
      pinnedRowEl.appendChild(chipEl);
    });
  }

  // ---------------------------------------------------------------
  // renderTabs (Carousel Logic)
  // ---------------------------------------------------------------
  function renderTabs(fullRebuild = false) {
    if (fullRebuild || tabsViewEl.children.length !== tabsData.length) {
      tabsViewEl.innerHTML = "";

      tabsData.forEach((tabData, i) => {
        const { browser, tab_id, window_id, title, url } = tabData;
        const chipEl = document.createElement("div");
        chipEl.className = "tab-chip";

        const dotEl = document.createElement("div");
        dotEl.className = `tab-dot ${browser}`;

        const titleEl = document.createElement("span");
        titleEl.className = "tab-title";
        titleEl.textContent = title || url || "Untitled Tab";

        const pinBtn = document.createElement("div");
        pinBtn.className = "pin-btn";
        
        const iconUnpinned = `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.68V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78.89A2 2 0 0 0 5 15.24Z"></path></svg>`;
        const iconPinned = `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(45deg);"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.68V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78.89A2 2 0 0 0 5 15.24Z"></path></svg>`;

        if (pinnedUrls.includes(url)) {
          pinBtn.classList.add("pinned");
          pinBtn.innerHTML = iconPinned;
        } else {
          pinBtn.innerHTML = iconUnpinned;
        }

        pinBtn.addEventListener("click", (e) => {
          e.stopPropagation(); // prevent clicking the chip
          if (pinnedUrls.includes(url)) {
            pinnedUrls = pinnedUrls.filter(u => u !== url);
            pinBtn.classList.remove("pinned");
            pinBtn.innerHTML = iconUnpinned;
          } else {
            pinnedUrls.push(url);
            pinBtn.classList.add("pinned");
            pinBtn.innerHTML = iconPinned;
          }
          saveSettings();
          renderPinnedRow();
        });

        chipEl.appendChild(dotEl);
        chipEl.appendChild(titleEl);
        chipEl.appendChild(pinBtn);

        chipEl.addEventListener("click", () => {
          updateSelectionState(i);
          renderTabs();
          invoke("switch_tab", {
            browser: browser,
            tabId: tab_id,
            windowId: window_id
          }).catch(err => console.error("Failed to switch tab:", err));
        });

        tabsViewEl.appendChild(chipEl);
      });
    }

    const chips = tabsViewEl.querySelectorAll(".tab-chip");
    if (chips.length === 0) return;

    // Constants for layout based on CSS
    const chipHeight = 32;
    const chipGap = 8;
    const itemStride = chipHeight + chipGap; // 40px per item in the flex layout

    // Shift the whole container so the selected item is centered.
    // The container has `top: 50%`. We translate it up by the selected item's top position + half its height.
    const offset = -(selectedIndex * itemStride + (chipHeight / 2));
    tabsViewEl.style.transform = `translateY(${offset}px)`;

    // Apply scaling and opacity to each chip based on distance from center
    chips.forEach((chip, i) => {
      // Selection highlight logic
      if (i === selectedIndex) {
        chip.classList.add("selected");
      } else {
        chip.classList.remove("selected");
      }

      const dist = Math.abs(i - selectedIndex);
      let scale = 1;
      let opacity = 1;

      if (dist === 0) {
        scale = 1.25;
        opacity = 1;
      } else {
        // Fall off scale: 0.85 for nearest neighbors, dropping by 0.15 further out, min 0.6
        scale = Math.max(0.6, 0.85 - (dist - 1) * 0.15);
        // Fall off opacity: drops steadily, min 0
        opacity = Math.max(0, 1 - dist * 0.25);
      }

      chip.style.transform = `scale(${scale})`;
      chip.style.opacity = opacity;
    });
  }
});
