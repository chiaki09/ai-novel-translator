// Content script for AI Web Novel Translator
class NovelTranslator {
  constructor() {
    this.isTranslated = false;
    this.translatedElements = new Map(); // element -> original text mapping
    this.currentUrl = window.location.href;
    this.isTranslating = false;

    // 部分翻訳用の状態管理
    this.currentElements = []; // 現在翻訳中の要素配列
    this.currentTexts = []; // 元テキスト配列

    // ストリーミング翻訳用の状態管理
    this.streamingResults = new Map(); // index -> accumulated text

    // DOM selectors in priority order (Web小説サイト向けに拡張)
    this.contentSelectors = [
      // 特定のWeb小説サイト用
      '.chapter-inner', '.chapter-body', '.chapter-text',
      '.story-text', '.fiction-text', '.novel-content',

      // 汎用的なコンテンツセレクタ
      'article', '.article-content',
      '.chapter-content', '.content', '.post-content',
      '.story-content', '.text-content',

      // コンテナ + 段落の組み合わせ
      'main', '.main-content', '.container',
      '#content', '#main-content',

      // 最後の手段として段落要素
      'main p', '.container p', 'body p', 'p'
    ];

    // Elements to exclude from translation
    this.excludeSelectors = [
      'nav', 'header', 'footer',
      '.nav', '.header', '.footer',
      '.advertisement', '.ad', '.ads',
      '.sidebar', '.menu', '.breadcrumb',
      '.comments', '.comment-section',
      '.author-note', '.metadata',
      'button', 'input', 'select', 'textarea',
      'script', 'style', 'noscript'
    ];
  }

  // メッセージリスナーを設定
  init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // 非同期レスポンスを示す
    });

    console.log('Novel Translator content script initialized');
  }

  async handleMessage(message, sender, sendResponse) {
    try {
      switch (message.action) {
        case 'translate':
          await this.translatePage();
          sendResponse({ success: true, isTranslated: this.isTranslated });
          break;

        case 'restore':
          this.restoreOriginal();
          sendResponse({ success: true, isTranslated: this.isTranslated });
          break;

        case 'getStatus':
          sendResponse({
            isTranslated: this.isTranslated,
            isTranslating: this.isTranslating,
            url: this.currentUrl
          });
          break;

        case 'clearCache':
          const clearResult = await chrome.runtime.sendMessage({
            action: 'clearCache',
            url: this.currentUrl
          });
          sendResponse({ success: clearResult?.success || false });
          break;

        case 'applyPartialTranslation':
          this.applyPartialTranslation(message.batchResults, message.batchIndex);
          sendResponse({ success: true });
          break;

        case 'translationProgress':
          this.applyProgressTranslation(message.startIndex, message.translations);
          sendResponse({ success: true });
          break;

        case 'streamChunk':
          this.handleStreamChunk(message.index, message.chunk, message.done);
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Content script error:', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  // ページ翻訳（デバッグ強化版）
  async translatePage() {
    if (this.isTranslating) {
      console.log('Translation already in progress');
      return;
    }

    if (this.isTranslated) {
      console.log('Page already translated');
      return;
    }

    this.isTranslating = true;
    const startTime = performance.now();

    try {
      // Phase 1: Cache Check (with error handling)
      console.log('🔍 Phase 1: Checking cache...');
      const cacheStart = performance.now();

      let cacheResult = null;
      try {
        cacheResult = await chrome.runtime.sendMessage({
          action: 'loadCache',
          url: this.currentUrl
        });
        console.log(`⏱️ Cache check: ${(performance.now() - cacheStart).toFixed(2)}ms`);
      } catch (cacheError) {
        console.warn('⚠️ Cache check failed:', cacheError.message);
        console.log('🔄 Continuing without cache...');
      }

      if (cacheResult && cacheResult.success && cacheResult.data) {
        console.log('✅ Using cached translation');
        this.applyTranslation(cacheResult.data);
        return;
      }

      // Phase 2: DOM Extraction
      console.log('🔍 Phase 2: Extracting text elements...');
      const extractStart = performance.now();

      const textElements = this.extractTextElementsFast();
      const extractTime = performance.now() - extractStart;

      console.log(`⏱️ DOM extraction: ${extractTime.toFixed(2)}ms`);
      console.log(`📊 Found ${textElements.length} elements`);

      if (textElements.length === 0) {
        throw new Error('翻訳対象のテキストが見つかりませんでした');
      }

      // Phase 3: Text Processing
      console.log('🔍 Phase 3: Processing text...');
      const processStart = performance.now();

      const textArray = textElements.map(el => el.textContent?.trim() || '').filter(text => text.length > 3);
      const processTime = performance.now() - processStart;

      console.log(`⏱️ Text processing: ${processTime.toFixed(2)}ms`);
      console.log(`📊 Processing ${textArray.length} paragraphs`);

      if (textArray.length === 0) {
        throw new Error('翻訳可能なテキストが見つかりません');
      }

      // Phase 4: Translation (with retry logic)
      console.log('🔍 Phase 4: Translating...');

      // 部分翻訳用に要素と元テキストを保存
      this.currentElements = textElements;
      this.currentTexts = textArray;

      const translateStart = performance.now();

      let result = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts && !result?.success) {
        attempts++;
        console.log(`🔄 Translation attempt ${attempts}/${maxAttempts}...`);

        try {
          result = await chrome.runtime.sendMessage({
            action: 'translateText',
            texts: textArray
          });

          const translateTime = performance.now() - translateStart;
          console.log(`⏱️ Translation attempt ${attempts}: ${translateTime.toFixed(2)}ms`);

          if (result && result.success) {
            console.log(`✅ Translation successful on attempt ${attempts}`);
            break;
          } else {
            console.warn(`⚠️ Translation attempt ${attempts} failed:`, result?.error);
          }

        } catch (translateError) {
          console.error(`❌ Translation attempt ${attempts} error:`, translateError);

          if (translateError.message.includes('Receiving end does not exist')) {
            console.log('🔄 Service worker may be inactive, waiting and retrying...');
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
          }

          if (attempts === maxAttempts) {
            throw new Error(`翻訳に失敗しました (${attempts}回試行): ${translateError.message}`);
          }
        }
      }

      if (!result || !result.success) {
        throw new Error(result?.error || '翻訳に失敗しました');
      }

      // Phase 5: Apply Translation (check if already applied by real-time updates)
      console.log('🔍 Phase 5: Checking translation completion...');
      const applyStart = performance.now();

      // リアルタイム表示で既に適用済みか確認
      const translatedCount = Array.from(this.translatedElements.keys()).length;

      if (translatedCount < textElements.length) {
        // 一部のみ翻訳済み、または未翻訳の場合は残りを適用
        console.log(`🔄 Applying remaining translations: ${translatedCount}/${textElements.length} already done`);
        this.applyTranslation({
          elements: textElements,
          originalTexts: textArray,
          translatedTexts: result.translatedTexts
        });
      } else {
        console.log(`✅ All translations already applied via real-time updates`);
      }

      const applyTime = performance.now() - applyStart;
      console.log(`⏱️ Apply translation check: ${applyTime.toFixed(2)}ms`);

      const totalTime = performance.now() - startTime;
      console.log(`🎯 TOTAL TIME: ${totalTime.toFixed(2)}ms (${(totalTime/1000).toFixed(1)}s)`);
      console.log(`✅ Completed: ${result.translatedTexts.length} paragraphs translated`);

      // Phase 6: Save to cache
      try {
        await chrome.runtime.sendMessage({
          action: 'saveCache',
          url: this.currentUrl,
          data: {
            elements: textElements,
            originalTexts: textArray,
            translatedTexts: result.translatedTexts
          }
        });
        console.log('💾 Translation cached successfully');
      } catch (cacheError) {
        console.warn('⚠️ Failed to cache translation:', cacheError);
      }

    } catch (error) {
      console.error('❌ Translation failed:', error);
      throw error;
    } finally {
      this.isTranslating = false;
    }
  }

  // デバッグ強化版DOM抽出
  extractTextElementsFast() {
    console.log('🚀 ENHANCED DOM EXTRACTION DEBUG');

    // Royal Road 完全特化セレクタ（実測に基づく）
    const royalRoadSelectors = [
      // Royal Road の実際の構造（よく使われる）
      '.chapter-inner .portlet-body p',
      '.chapter-inner p',
      '.chapter-content p',
      '.portlet-body p',
      '.fiction-page p',
      '.chapter p',

      // Royal Road の代替構造
      'div[class*="chapter"] p',
      'div[class*="content"] p',
      '.row .col-md-10 p', // Royal Roadのレイアウト構造

      // 最終フォールバック
      'p'
    ];

    for (const selector of royalRoadSelectors) {
      const elements = Array.from(document.querySelectorAll(selector));

      if (elements.length > 0) {
        console.log(`🔍 Selector "${selector}": found ${elements.length} elements`);

        // より緩いフィルタリング
        let debugCount = 0;
        const filtered = elements.filter(el => {
          const text = el.textContent.trim();
          const computedStyle = getComputedStyle(el);

          // 詳細フィルタ条件をログ出力
          const checks = {
            textLength: text.length,
            hasEnglish: /[a-zA-Z]/.test(text),
            isVisible: computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden',
            notExcluded: !el.closest('nav, header, footer, script, style, .sidebar, .menu')
          };

          const shouldInclude = checks.textLength > 10 &&
                              checks.hasEnglish &&
                              checks.isVisible &&
                              checks.notExcluded;

          // 最初の5要素の詳細をログ出力
          if (shouldInclude && debugCount < 5) {
            console.log(`Element ${debugCount + 1}:`, {
              ...checks,
              sample: text.substring(0, 100),
              included: shouldInclude
            });
            debugCount++;
          }

          return shouldInclude;
        });

        console.log(`✅ Selected ${filtered.length} elements with "${selector}"`);

        if (filtered.length > 0) {
          // 制限を完全撤廃（完全翻訳のため）
          const result = filtered; // 全ての要素を使用

          console.log(`📊 COMPLETE EXTRACTION SUMMARY:`);
          console.log(`- Selector used: "${selector}"`);
          console.log(`- ALL elements found: ${result.length}`);
          console.log(`- Sample texts:`, result.slice(0, 3).map(el => el.textContent.substring(0, 80)));
          console.log(`- Average text length: ${Math.round(result.reduce((sum, el) => sum + el.textContent.length, 0) / result.length)}`);
          console.log(`- Total characters: ${result.reduce((sum, el) => sum + el.textContent.length, 0)}`);

          return result;
        }
      } else {
        console.log(`❌ Selector "${selector}": no elements found`);
      }
    }

    console.error('🚨 NO SUITABLE ELEMENTS FOUND! Trying emergency fallback...');

    // 緊急フォールバック：全ての長いテキストを含む要素
    const allElements = Array.from(document.querySelectorAll('*'));
    const emergencyElements = allElements.filter(el => {
      const text = el.textContent.trim();
      return text.length > 50 &&
             el.children.length <= 5 &&
             /[a-zA-Z]/.test(text) &&
             !el.closest('nav, header, footer, script, style');
    });

    console.log(`🆘 Emergency fallback: ${emergencyElements.length} elements`);
    return emergencyElements.slice(0, 100);
  }

  /* 以下の複雑な関数は高速化のためコメントアウト
  // extractParagraphsFromContainer, findElementsBySelector,
  // shouldExcludeElement, containsEnoughEnglish
  // 超高速版のextractTextElementsFast()を使用 */

  // 超高速翻訳適用（最小限の処理）
  applyTranslation(translationData) {
    const { elements, translatedTexts } = translationData;
    const maxLength = Math.min(elements.length, translatedTexts.length);

    for (let i = 0; i < maxLength; i++) {
      const element = elements[i];
      const translatedText = translatedTexts[i];

      if (translatedText && translatedText.trim() && element) {
        // 元のテキストを最小限で保存
        this.translatedElements.set(element, element.textContent);

        // 高速翻訳適用
        this.applySimpleTranslation(element, translatedText.trim());
      }
    }

    this.isTranslated = true;
    console.log(`Fast translation applied: ${maxLength} elements`);
  }

  // Fast text application - no complex HTML processing
  applySimpleTranslation(element, translatedText) {
    if (element && translatedText) {
      // Basic line break preservation only
      if (element.textContent.includes('\n')) {
        element.innerHTML = translatedText.replace(/\n/g, '<br>');
      } else {
        element.textContent = translatedText;
      }
    }
  }

  // 部分翻訳結果の適用
  applyPartialTranslation(batchResults, batchIndex) {
    console.log(`🔄 Applying partial translation: batch ${batchIndex + 1}, ${batchResults.length} results`);

    const startIndex = batchIndex * 8; // バッチサイズ8を仮定
    const maxLength = Math.min(batchResults.length, this.currentElements.length - startIndex);

    for (let i = 0; i < maxLength; i++) {
      const elementIndex = startIndex + i;
      const element = this.currentElements[elementIndex];
      const translatedText = batchResults[i];

      if (element && translatedText && translatedText.trim()) {
        // 元のテキストを保存（まだ保存されていない場合）
        if (!this.translatedElements.has(element)) {
          this.translatedElements.set(element, element.textContent);
        }

        // 翻訳テキストを適用
        this.applySimpleTranslation(element, translatedText.trim());

        console.log(`✅ Applied partial translation ${i + 1}/${maxLength}: "${translatedText.substring(0, 50)}..."`);
      }
    }

    console.log(`🔄 Partial translation batch ${batchIndex + 1} applied`);
  }

  // 超高速復元
  restoreOriginal() {
    this.translatedElements.forEach((originalText, element) => {
      if (element.isConnected) {
        element.textContent = originalText;
      }
    });

    this.translatedElements.clear();
    this.currentElements = []; // 部分翻訳用状態もクリア
    this.currentTexts = [];
    this.streamingResults.clear(); // ストリーミング状態もクリア
    this.isTranslated = false;
    console.log('Fast restore complete');
  }

  // リアルタイム進捗翻訳適用
  applyProgressTranslation(startIndex, translations) {
    if (!this.currentElements || !this.currentTexts) {
      console.warn('No current translation context available');
      return;
    }

    console.log(`📤 Applying progress translation: index ${startIndex}, count ${translations.length}`);

    for (let i = 0; i < translations.length; i++) {
      const elementIndex = startIndex + i;

      if (elementIndex >= this.currentElements.length) {
        console.warn(`Element index ${elementIndex} out of range (${this.currentElements.length})`);
        continue;
      }

      const element = this.currentElements[elementIndex];
      const originalText = this.currentTexts[elementIndex];
      const translatedText = translations[i];

      // 元のテキストを保存（まだ保存されていない場合）
      if (!this.translatedElements.has(element)) {
        this.translatedElements.set(element, element.textContent);
      }

      try {
        // 翻訳を適用
        this.applySimpleTranslation(element, translatedText);
        console.log(`✅ Applied translation ${elementIndex + 1}/${this.currentElements.length}: "${translatedText.substring(0, 50)}..."`);
      } catch (error) {
        console.error(`Failed to apply translation for element ${elementIndex}:`, error);
      }
    }

    // 完了状況を確認
    const translatedCount = Array.from(this.translatedElements.keys()).length;
    if (translatedCount === this.currentElements.length) {
      console.log(`🎉 All ${translatedCount} paragraphs translated and applied!`);
      this.isTranslated = true;
      this.isTranslating = false;
    }
  }

  // ストリーミングチャンク処理
  handleStreamChunk(index, chunk, done) {
    if (!this.currentElements || index >= this.currentElements.length) {
      return;
    }

    const element = this.currentElements[index];

    // 初回チャンクの場合、元のテキストを保存
    if (!this.translatedElements.has(element)) {
      this.translatedElements.set(element, element.textContent);
    }

    if (!done && chunk) {
      // チャンクを蓄積
      const currentText = this.streamingResults.get(index) || '';
      const newText = currentText + chunk;
      this.streamingResults.set(index, newText);

      // リアルタイム表示
      this.applySimpleTranslation(element, newText);
    } else if (done) {
      // 翻訳完了
      const finalText = this.streamingResults.get(index) || chunk || '[翻訳失敗]';
      this.streamingResults.delete(index);

      // 最終テキストを適用
      this.applySimpleTranslation(element, finalText);

      // 全体の完了確認
      this.checkTranslationCompletion();
    }
  }

  // 翻訳完了チェック
  checkTranslationCompletion() {
    if (!this.currentElements) return;

    const translatedCount = Array.from(this.translatedElements.keys()).length;
    const streamingCount = this.streamingResults.size;

    if (translatedCount === this.currentElements.length && streamingCount === 0) {
      console.log(`🎉 All ${translatedCount} paragraphs streaming translation completed!`);
      this.isTranslated = true;
      this.isTranslating = false;
    }
  }

}

// URLが変更された際の処理
function handleUrlChange() {
  const newUrl = window.location.href;
  if (novelTranslator.currentUrl !== newUrl) {
    console.log('URL changed, resetting translator state');
    novelTranslator.restoreOriginal();
    novelTranslator.currentUrl = newUrl;
  }
}

// No UI decorations - maximum speed version

// SPA対応: URLの変更を監視
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    handleUrlChange();
  }
}).observe(document, { subtree: true, childList: true });

// インスタンスを作成して初期化
const novelTranslator = new NovelTranslator();
novelTranslator.init();