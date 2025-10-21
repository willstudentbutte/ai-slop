/* Open full dashboard page when the action icon is clicked */
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.create({ url });
});

