/* Open full dashboard page when the action icon is clicked */
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.create({ url });
});

/* Listen for dashboard open requests from content script */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'open_dashboard') {
    const url = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.create({ url }, (tab) => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true; // Keep message channel open for async response
  }
});

