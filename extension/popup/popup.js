// Popup script for AI Web Novel Translator
class PopupController {
  constructor() {
    this.currentTab = null;
    this.isTranslated = false;
    this.isTranslating = false;
    this.hasApiKey = false;

    // DOM elements
    this.elements = {};

    // 初期化
    this.init();
  }

  async init() {
    try {
      console.log('🚀 Initializing popup...');

      // DOM要素を取得
      this.getDOMElements();

      // イベントリスナーを設定
      this.setupEventListeners();

      // 現在のタブを取得
      await this.getCurrentTab();
      console.log('📋 Current tab:', this.currentTab?.url);

      // Service Worker状態確認
      await this.checkServiceWorkerStatus();

      // APIキーの存在確認
      await this.checkApiKey();

      // 翻訳状態を確認
      await this.checkTranslationStatus();

      // UIを更新
      this.updateUI();

      console.log('✅ Popup initialized successfully');
    } catch (error) {
      console.error('❌ Popup initialization failed:', error);
      this.showError('初期化に失敗しました: ' + error.message);
    }
  }

  // Service Worker状態確認
  async checkServiceWorkerStatus() {
    try {
      console.log('🔍 Checking Service Worker status...');

      const response = await chrome.runtime.sendMessage({ action: 'healthCheck' });
      console.log('✅ Service Worker is active:', response);
    } catch (error) {
      console.warn('⚠️ Service Worker may be inactive:', error.message);

      // Service Worker起動のために軽量なメッセージを送信
      try {
        await chrome.storage.local.get('test');
        console.log('🔄 Service Worker activated via storage access');
      } catch (storageError) {
        console.warn('⚠️ Service Worker activation failed:', storageError);
      }
    }
  }

  getDOMElements() {
    const elementIds = [
      'noApiKeySection', 'mainSection', 'errorSection',
      'statusIndicator', 'statusText', 'translateButton', 'restoreButton',
      'progressSection', 'progressFill', 'progressText',
      'translationInfo', 'cacheStatus', 'errorMessage',
      'openSettingsButton', 'settingsLink', 'clearCacheButton', 'retryButton'
    ];

    elementIds.forEach(id => {
      this.elements[id] = document.getElementById(id);
    });
  }

  setupEventListeners() {
    // 翻訳ボタン
    this.elements.translateButton.addEventListener('click', () => {
      this.handleTranslate();
    });

    // 復元ボタン
    this.elements.restoreButton.addEventListener('click', () => {
      this.handleRestore();
    });

    // 設定ボタン
    this.elements.openSettingsButton.addEventListener('click', () => {
      this.openSettings();
    });

    this.elements.settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.openSettings();
    });

    // キャッシュクリアボタン
    this.elements.clearCacheButton.addEventListener('click', () => {
      this.handleClearCache();
    });

    // 再試行ボタン
    this.elements.retryButton.addEventListener('click', () => {
      this.handleRetry();
    });

    // バックグラウンドからのメッセージを受信
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleBackgroundMessage(message);
    });
  }

  async getCurrentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tabs[0];
  }

  async checkApiKey() {
    try {
      const result = await chrome.storage.local.get(['geminiApiKey']);
      this.hasApiKey = !!(result.geminiApiKey && result.geminiApiKey.trim());
    } catch (error) {
      console.error('Failed to check API key:', error);
      this.hasApiKey = false;
    }
  }

  async checkTranslationStatus() {
    if (!this.currentTab) return;

    try {
      console.log('🔍 Checking translation status...');

      const response = await this.sendMessageWithRetry(this.currentTab.id, {
        action: 'getStatus'
      }, 2); // 最大2回試行

      if (response) {
        this.isTranslated = response.isTranslated || false;
        this.isTranslating = response.isTranslating || false;
        console.log('📊 Status:', { translated: this.isTranslated, translating: this.isTranslating });
      }
    } catch (error) {
      console.log('⚠️ Content script not ready yet:', error.message);
      // コンテンツスクリプトがまだ準備できていない場合はデフォルト値を使用
      this.isTranslated = false;
      this.isTranslating = false;
    }
  }

  updateUI() {
    // セクションの表示/非表示
    if (!this.hasApiKey) {
      this.showSection('noApiKeySection');
    } else if (this.elements.errorSection && !this.elements.errorSection.classList.contains('hidden')) {
      // エラー状態の場合はそのまま維持
    } else {
      this.showSection('mainSection');
    }

    // ステータスインジケーターの更新
    this.updateStatusIndicator();

    // ボタン状態の更新
    this.updateButtons();

    // 翻訳情報の更新
    this.updateTranslationInfo();
  }

  updateStatusIndicator() {
    const dot = this.elements.statusIndicator.querySelector('.status-dot');
    const statusText = this.elements.statusText;

    if (!this.hasApiKey) {
      dot.className = 'status-dot error';
      statusText.textContent = 'APIキー未設定';
    } else if (this.isTranslating) {
      dot.className = 'status-dot warning';
      statusText.textContent = '翻訳中...';
    } else if (this.isTranslated) {
      dot.className = 'status-dot success';
      statusText.textContent = '翻訳完了';
    } else {
      dot.className = 'status-dot ready';
      statusText.textContent = '準備完了';
    }
  }

  updateButtons() {
    const translateBtn = this.elements.translateButton;
    const restoreBtn = this.elements.restoreButton;

    if (this.isTranslating) {
      translateBtn.disabled = true;
      translateBtn.classList.add('loading');
      translateBtn.querySelector('.button-text').textContent = '翻訳中...';
      restoreBtn.classList.add('hidden');
    } else if (this.isTranslated) {
      translateBtn.classList.add('hidden');
      restoreBtn.classList.remove('hidden');
      restoreBtn.disabled = false;
    } else {
      translateBtn.classList.remove('hidden', 'loading');
      translateBtn.disabled = !this.hasApiKey;
      translateBtn.querySelector('.button-text').textContent = 'ページを翻訳';
      restoreBtn.classList.add('hidden');
    }
  }

  updateTranslationInfo() {
    const infoSection = this.elements.translationInfo;

    if (this.isTranslated) {
      infoSection.classList.remove('hidden');
      // キャッシュ状態は実際にチェックする必要があるが、今は簡略化
      this.elements.cacheStatus.textContent = '利用可能';
    } else {
      infoSection.classList.add('hidden');
    }
  }

  showSection(sectionName) {
    // 全セクションを非表示
    ['noApiKeySection', 'mainSection', 'errorSection'].forEach(name => {
      if (this.elements[name]) {
        this.elements[name].classList.add('hidden');
      }
    });

    // 指定セクションを表示
    if (this.elements[sectionName]) {
      this.elements[sectionName].classList.remove('hidden');
    }
  }

  async handleTranslate() {
    if (!this.currentTab || !this.hasApiKey) return;

    this.isTranslating = true;
    this.updateUI();
    this.showProgress(true, 'Content Script確認中...');

    try {
      // Step 1: Content Scriptの注入確認と実行
      await this.ensureContentScriptInjected();

      this.showProgress(true, '翻訳を開始中...');

      // Step 2: 翻訳実行（リトライ付き）
      const response = await this.sendMessageWithRetry(this.currentTab.id, {
        action: 'translate'
      }, 3);

      if (response && response.success) {
        this.isTranslated = response.isTranslated;
        this.showProgress(false);
        this.updateUI();
      } else {
        throw new Error(response?.error || '翻訳に失敗しました');
      }
    } catch (error) {
      console.error('Translation failed:', error);
      this.showError(error.message);
    } finally {
      this.isTranslating = false;
      this.showProgress(false);
      this.updateUI();
    }
  }

  // Content Scriptの注入を確実にする
  async ensureContentScriptInjected() {
    console.log('🔍 Checking Content Script injection...');

    try {
      // まずContent Scriptが応答するかテスト
      const testResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'getStatus'
      });

      console.log('✅ Content Script already active:', testResponse);
      return true;
    } catch (error) {
      console.log('⚠️ Content Script not responding, injecting...');

      // Content Scriptを手動注入
      try {
        await chrome.scripting.executeScript({
          target: { tabId: this.currentTab.id },
          files: ['content/content.js']
        });

        // CSS も注入
        await chrome.scripting.insertCSS({
          target: { tabId: this.currentTab.id },
          files: ['content/content.css']
        });

        console.log('✅ Content Script injected successfully');

        // 少し待ってから再度テスト
        await new Promise(resolve => setTimeout(resolve, 1000));

        const finalTest = await chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'getStatus'
        });

        console.log('✅ Content Script now active:', finalTest);
        return true;

      } catch (injectionError) {
        console.error('❌ Content Script injection failed:', injectionError);
        throw new Error(`Content Script注入に失敗しました: ${injectionError.message}`);
      }
    }
  }

  // リトライ付きメッセージ送信
  async sendMessageWithRetry(tabId, message, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`🔄 Message attempt ${attempt}/${maxRetries}:`, message.action);

      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        console.log(`✅ Message successful on attempt ${attempt}:`, response);
        return response;
      } catch (error) {
        console.warn(`⚠️ Message attempt ${attempt} failed:`, error.message);
        lastError = error;

        if (error.message.includes('Receiving end does not exist')) {
          // Content Scriptの問題の場合、再注入を試す
          if (attempt < maxRetries) {
            console.log('🔄 Retrying Content Script injection...');
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

            try {
              await this.ensureContentScriptInjected();
            } catch (injectionError) {
              console.warn('Content Script re-injection failed:', injectionError);
            }
          }
        } else {
          // 他のエラーの場合は短い待機
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
      }
    }

    throw lastError;
  }

  async handleRestore() {
    if (!this.currentTab) return;

    try {
      console.log('🔄 Restoring original text...');

      const response = await this.sendMessageWithRetry(this.currentTab.id, {
        action: 'restore'
      }, 3);

      if (response && response.success) {
        this.isTranslated = response.isTranslated;
        console.log('✅ Restore successful');
        this.updateUI();
      } else {
        throw new Error(response?.error || '復元に失敗しました');
      }
    } catch (error) {
      console.error('❌ Restore failed:', error);
      this.showError(`復元エラー: ${error.message}`);
    }
  }

  async handleClearCache() {
    if (!this.currentTab) return;

    try {
      console.log('🗑️ Clearing cache...');

      const response = await this.sendMessageWithRetry(this.currentTab.id, {
        action: 'clearCache'
      }, 2);

      if (response && response.success) {
        console.log('✅ Cache cleared successfully');
        this.showTemporaryMessage('キャッシュをクリアしました');
      } else {
        console.warn('⚠️ Cache clear may have failed:', response);
      }
    } catch (error) {
      console.error('❌ Cache clear failed:', error);
      this.showTemporaryMessage('キャッシュクリアに失敗しました');
    }
  }

  handleRetry() {
    // エラー状態をクリアして再初期化
    this.showSection('mainSection');
    this.handleTranslate();
  }

  openSettings() {
    chrome.runtime.openOptionsPage();
  }

  showProgress(show, text = '翻訳中...') {
    const progressSection = this.elements.progressSection;
    const progressText = this.elements.progressText;

    if (show) {
      progressSection.classList.remove('hidden');
      progressText.textContent = text;
      // 簡単なプログレスアニメーション（実際の進捗ではない）
      this.animateProgress();
    } else {
      progressSection.classList.add('hidden');
    }
  }

  animateProgress() {
    const progressFill = this.elements.progressFill;
    let width = 0;
    const interval = setInterval(() => {
      width += 2;
      progressFill.style.width = Math.min(width, 90) + '%';

      if (width >= 90) {
        clearInterval(interval);
      }
    }, 100);
  }

  showError(message) {
    this.elements.errorMessage.textContent = message;
    this.showSection('errorSection');
  }

  showTemporaryMessage(message) {
    const statusText = this.elements.statusText;
    const originalText = statusText.textContent;

    statusText.textContent = message;
    setTimeout(() => {
      statusText.textContent = originalText;
    }, 2000);
  }

  handleBackgroundMessage(message) {
    switch (message.action) {
      case 'translationError':
        this.showError(message.error);
        this.isTranslating = false;
        this.updateUI();
        break;
    }
  }
}

// ポップアップが読み込まれたら初期化
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});