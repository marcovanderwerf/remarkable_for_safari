/**
 * Popup script for reMarkable Safari Extension
 */

(function() {
  'use strict';

  // State
  let currentArticle = null;
  let isConnected = false;
  let folders = [];

  // DOM Elements
  const views = {
    notConnected: document.getElementById('not-connected'),
    loading: document.getElementById('loading-view'),
    article: document.getElementById('article-view'),
    success: document.getElementById('success-view'),
    error: document.getElementById('error-view')
  };

  const elements = {
    mainView: document.getElementById('main-view'),
    settingsView: document.getElementById('settings-view'),
    authModal: document.getElementById('auth-modal'),
    settingsBtn: document.getElementById('settings-btn'),
    backBtn: document.getElementById('back-btn'),
    connectBtn: document.getElementById('connect-btn'),
    settingsConnectBtn: document.getElementById('settings-connect-btn'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    sendBtn: document.getElementById('send-btn'),
    sendBtnText: document.getElementById('send-btn-text'),
    sendBtnLoading: document.getElementById('send-btn-loading'),
    doneBtn: document.getElementById('done-btn'),
    retryBtn: document.getElementById('retry-btn'),
    closeModal: document.getElementById('close-modal'),
    cancelAuth: document.getElementById('cancel-auth'),
    submitAuth: document.getElementById('submit-auth'),
    authCode: document.getElementById('auth-code'),
    authError: document.getElementById('auth-error'),
    articleTitle: document.getElementById('article-title'),
    articleMeta: document.getElementById('article-meta'),
    folderSelect: document.getElementById('folder-select'),
    defaultFolder: document.getElementById('default-folder'),
    loadingText: document.getElementById('loading-text'),
    successMessage: document.getElementById('success-message'),
    errorMessage: document.getElementById('error-message'),
    accountInfo: document.getElementById('account-info'),
    accountNotConnected: document.getElementById('account-not-connected'),
    accountEmail: document.getElementById('account-email'),
    includeImages: document.getElementById('include-images'),
    simplifyLayout: document.getElementById('simplify-layout')
  };

  // Initialize
  async function init() {
    setupEventListeners();
    await loadSettings();
    await checkConnection();

    if (isConnected) {
      await extractArticle();
    }
  }

  // Event Listeners
  function setupEventListeners() {
    // Navigation
    elements.settingsBtn.addEventListener('click', showSettings);
    elements.backBtn.addEventListener('click', hideSettings);

    // Auth
    elements.connectBtn.addEventListener('click', showAuthModal);
    elements.settingsConnectBtn.addEventListener('click', showAuthModal);
    elements.disconnectBtn.addEventListener('click', disconnect);
    elements.closeModal.addEventListener('click', hideAuthModal);
    elements.cancelAuth.addEventListener('click', hideAuthModal);
    elements.submitAuth.addEventListener('click', submitAuth);
    elements.authCode.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitAuth();
    });

    // Actions
    elements.sendBtn.addEventListener('click', sendToRemarkable);
    elements.doneBtn.addEventListener('click', () => window.close());
    elements.retryBtn.addEventListener('click', () => extractArticle());

    // Settings
    elements.includeImages.addEventListener('change', saveSettings);
    elements.simplifyLayout.addEventListener('change', saveSettings);
    elements.defaultFolder.addEventListener('change', saveSettings);
  }

  // View Management
  function showView(viewName) {
    Object.values(views).forEach(view => view.classList.add('hidden'));
    if (views[viewName]) {
      views[viewName].classList.remove('hidden');
    }
  }

  function showSettings() {
    elements.mainView.classList.add('hidden');
    elements.settingsView.classList.remove('hidden');
    updateAccountUI();
  }

  function hideSettings() {
    elements.settingsView.classList.add('hidden');
    elements.mainView.classList.remove('hidden');
  }

  function showAuthModal() {
    elements.authModal.classList.remove('hidden');
    elements.authCode.value = '';
    elements.authError.classList.add('hidden');
    elements.authCode.focus();
  }

  function hideAuthModal() {
    elements.authModal.classList.add('hidden');
    elements.authCode.value = '';
    elements.authError.classList.add('hidden');
  }

  // Connection Management
  async function checkConnection() {
    try {
      const response = await browser.runtime.sendMessage({ action: 'checkAuth' });
      isConnected = response.isAuthenticated;

      if (isConnected) {
        folders = response.folders || [];
        updateFolderSelects();
        updateAccountUI(response.email);
      } else {
        showView('notConnected');
      }
    } catch (error) {
      console.error('Error checking connection:', error);
      showView('notConnected');
    }
  }

  async function submitAuth() {
    const code = elements.authCode.value.trim();

    if (!code) {
      showAuthError('Please enter a code');
      return;
    }

    elements.submitAuth.disabled = true;
    elements.submitAuth.textContent = 'Connecting...';

    try {
      const response = await browser.runtime.sendMessage({
        action: 'authenticate',
        code: code
      });

      if (response.success) {
        isConnected = true;
        folders = response.folders || [];
        hideAuthModal();
        updateFolderSelects();
        await extractArticle();
      } else {
        showAuthError(response.error || 'Authentication failed');
      }
    } catch (error) {
      showAuthError('Connection error. Please try again.');
    } finally {
      elements.submitAuth.disabled = false;
      elements.submitAuth.textContent = 'Connect';
    }
  }

  async function disconnect() {
    try {
      await browser.runtime.sendMessage({ action: 'disconnect' });
      isConnected = false;
      folders = [];
      hideSettings();
      showView('notConnected');
      updateAccountUI();
    } catch (error) {
      console.error('Error disconnecting:', error);
    }
  }

  function showAuthError(message) {
    elements.authError.textContent = message;
    elements.authError.classList.remove('hidden');
  }

  // Article Extraction
  async function extractArticle() {
    showView('loading');
    elements.loadingText.textContent = 'Extracting article...';

    try {
      // Get the active tab
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];

      if (!tab) {
        throw new Error('No active tab found');
      }

      // Request article extraction from content script
      const response = await browser.tabs.sendMessage(tab.id, { action: 'extractArticle' });

      if (response && response.success) {
        currentArticle = response;
        displayArticle(response);
        showView('article');
      } else {
        throw new Error(response?.error || 'Failed to extract article');
      }
    } catch (error) {
      console.error('Error extracting article:', error);
      elements.errorMessage.textContent = error.message || 'Unable to extract article from this page.';
      showView('error');
    }
  }

  function displayArticle(article) {
    elements.articleTitle.textContent = article.title || 'Untitled';

    const meta = [];
    if (article.siteName) meta.push(article.siteName);
    if (article.byline) meta.push(article.byline);
    if (article.length) {
      const readTime = Math.ceil(article.length / 1500); // ~250 words/min, 6 chars/word
      meta.push(`${readTime} min read`);
    }

    elements.articleMeta.textContent = meta.join(' • ');
  }

  // Send to reMarkable
  async function sendToRemarkable() {
    if (!currentArticle) {
      showView('error');
      elements.errorMessage.textContent = 'No article to send.';
      return;
    }

    // Update button state
    elements.sendBtn.disabled = true;
    elements.sendBtnText.classList.add('hidden');
    elements.sendBtnLoading.classList.remove('hidden');

    try {
      const settings = await loadSettings();
      const folderId = elements.folderSelect.value || settings.defaultFolder || '';

      const response = await browser.runtime.sendMessage({
        action: 'sendToRemarkable',
        article: currentArticle,
        options: {
          folderId: folderId,
          includeImages: settings.includeImages,
          simplifyLayout: settings.simplifyLayout
        }
      });

      if (response.success) {
        elements.successMessage.textContent = `"${currentArticle.title}" is now on your reMarkable.`;
        showView('success');
      } else {
        throw new Error(response.error || 'Failed to send article');
      }
    } catch (error) {
      console.error('Error sending to reMarkable:', error);
      elements.errorMessage.textContent = error.message || 'Unable to send article.';
      showView('error');
    } finally {
      elements.sendBtn.disabled = false;
      elements.sendBtnText.classList.remove('hidden');
      elements.sendBtnLoading.classList.add('hidden');
    }
  }

  // Settings Management
  async function loadSettings() {
    try {
      const result = await browser.storage.local.get(['settings']);
      const settings = result.settings || {
        includeImages: true,
        simplifyLayout: true,
        defaultFolder: ''
      };

      elements.includeImages.checked = settings.includeImages !== false;
      elements.simplifyLayout.checked = settings.simplifyLayout !== false;

      return settings;
    } catch (error) {
      console.error('Error loading settings:', error);
      return {
        includeImages: true,
        simplifyLayout: true,
        defaultFolder: ''
      };
    }
  }

  async function saveSettings() {
    try {
      const settings = {
        includeImages: elements.includeImages.checked,
        simplifyLayout: elements.simplifyLayout.checked,
        defaultFolder: elements.defaultFolder.value
      };

      await browser.storage.local.set({ settings });
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  function updateFolderSelects() {
    const options = '<option value="">Root</option>' +
      folders.map(folder => `<option value="${folder.id}">${folder.name}</option>`).join('');

    elements.folderSelect.innerHTML = options;
    elements.defaultFolder.innerHTML = options;
  }

  function updateAccountUI(email) {
    if (isConnected && email) {
      elements.accountInfo.classList.remove('hidden');
      elements.accountNotConnected.classList.add('hidden');
      elements.accountEmail.textContent = email;
    } else {
      elements.accountInfo.classList.add('hidden');
      elements.accountNotConnected.classList.remove('hidden');
    }
  }

  // Start
  document.addEventListener('DOMContentLoaded', init);

})();
