// Открываем боковую панель по клику на иконку расширения
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Разрешаем открывать панель на любой вкладке
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
