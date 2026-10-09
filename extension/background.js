// Toolbar icon opens the side panel; the in-Gmail badge asks us to open it too.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "openPanel" && sender.tab?.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }
});
