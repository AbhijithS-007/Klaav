const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let tabsData = [];
let selectedTabId = null;
let selectedBrowser = null;
let selectedIndex = -1;
let groupByBrowser = false;

window.addEventListener("DOMContentLoaded", async () => {
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
    settingsPanel.classList.toggle("open");
  });

  async function saveSettings() {
    try {
      await invoke("save_settings", { settings: { groupByBrowser, theme: currentTheme } });
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
    document.getElementById("loading-state").style.display = "none";
    tabsData = event.payload || [];

    sortTabsData();

    if (tabsData.length === 0) {
      selectedIndex = -1;
      selectedTabId = null;
      selectedBrowser = null;
      renderTabs(true);
      return;
    }

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

    renderTabs(true);
  });

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

        chipEl.appendChild(dotEl);
        chipEl.appendChild(titleEl);

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
