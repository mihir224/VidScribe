const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com"]);

function isYouTubeWatchUrl(url?: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return YOUTUBE_HOSTS.has(parsed.hostname) && parsed.pathname === "/watch";
  } catch {
    return false;
  }
}

async function updateSidePanel(tabId: number, url?: string) {
  await chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled: isYouTubeWatchUrl(url)
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url || tab.url) {
    void updateSidePanel(tabId, info.url ?? tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await updateSidePanel(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "VIDSCRIBE_CAPTURE_VISIBLE_TAB") {
    return undefined;
  }

  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    sendResponse({
      ok: false,
      error: "Capture request did not come from a tab"
    });
    return undefined;
  }

  chrome.tabs.captureVisibleTab(
    windowId,
    {
      format: "jpeg",
      quality: 70
    },
    (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    }
  );

  return true;
});
