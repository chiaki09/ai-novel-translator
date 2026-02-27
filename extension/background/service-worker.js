// Background service worker for AI Web Novel Translator (MVP version)

// Gemini API設定
let CURRENT_MODEL = null; // 利用可能なモデルをキャッシュ

// 起動時にキャッシュされたモデルを読み込み
chrome.runtime.onStartup.addListener(async () => {
  await loadCachedModel();
});

// Service Worker起動時にもモデルを読み込み
(async () => {
  await loadCachedModel();
})();
const SYSTEM_PROMPT = `プロ翻訳者として以下の英語テキストを日本語に翻訳してください。

【重要ルール】
1. 翻訳結果のみ出力（説明不要）
2. 全ての段落を完全に翻訳
3. 区切り文字「###TRANSLATE_SEPARATOR###」は削除して翻訳結果のみ出力
4. 人名・地名はカタカナ表記
5. 同じ段落構造を維持

【出力形式】
段落1の翻訳

###TRANSLATE_SEPARATOR###

段落2の翻訳

###TRANSLATE_SEPARATOR###

段落3の翻訳

【厳重注意】
- 区切り文字「###TRANSLATE_SEPARATOR###」を翻訳しない
- 全段落を確実に翻訳完了
- 繰り返し文は禁止

以下を翻訳：`;

// 拡張機能のインストール時
chrome.runtime.onInstalled.addListener((details) => {
  console.log('AI Web Novel Translator installed/updated', details);

  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  const startTime = performance.now();
  console.log(`🔔 Background received message: ${message.action}`, {
    timestamp: new Date().toISOString(),
    sender: sender.tab ? `tab ${sender.tab.id}` : 'extension',
    textsCount: message.texts?.length || 0
  });

  try {
    switch (message.action) {
      case 'translateText':
        console.log(`🔄 Processing translation request: ${message.texts?.length} texts`);
        // sender.tab.idを翻訳処理に渡す
        const translateResult = await translateTexts(message.texts, sender.tab?.id);
        const processTime = performance.now() - startTime;
        console.log(`✅ Translation completed in ${processTime.toFixed(2)}ms`);
        sendResponse(translateResult);
        break;

      case 'loadCache':
        console.log(`🗄️ Loading cache for: ${message.url}`);
        const cacheData = await loadCache(message.url);
        sendResponse({ success: true, data: cacheData });
        break;

      case 'saveCache':
        console.log(`💾 Saving cache for: ${message.url}`);
        const saveResult = await saveCache(message.url, message.data);
        sendResponse({ success: saveResult });
        break;

      case 'clearCache':
        console.log(`🗑️ Clearing cache for: ${message.url}`);
        const clearResult = await clearCacheForUrl(message.url);
        sendResponse({ success: clearResult });
        break;

      case 'translationError':
        console.error('❌ Translation error reported:', message.error);
        sendResponse({ success: true });
        break;

      case 'translationComplete':
        console.log('✅ Translation completed:', {
          url: message.url,
          elementsTranslated: message.elementsCount,
          timestamp: new Date().toISOString()
        });
        sendResponse({ success: true });
        break;

      case 'healthCheck':
        console.log('💓 Health check received');
        sendResponse({
          success: true,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          model: CURRENT_MODEL
        });
        break;

      default:
        console.error(`❌ Unknown action: ${message.action}`);
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    const processTime = performance.now() - startTime;
    console.error(`❌ Background script error after ${processTime.toFixed(2)}ms:`, error);
    console.error(`❌ Error details:`, {
      action: message.action,
      error: error.message,
      stack: error.stack
    });
    sendResponse({ success: false, error: error.message });
  }
}

// 翻訳機能
async function translateTexts(texts, tabId) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { success: false, error: '翻訳対象のテキストがありません' };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: 'APIキーが設定されていません。設定画面でAPIキーを入力してください。',
      needsApiKey: true
    };
  }

  try {
    // 利用可能なモデルを取得（複数の方法で試行）
    if (!CURRENT_MODEL) {
      CURRENT_MODEL = await findAvailableModelSimple(apiKey);

      // シンプルな方法で見つからない場合、最後の手段を試す
      if (!CURRENT_MODEL) {
        CURRENT_MODEL = await tryLastResortModels(apiKey);
      }

      if (!CURRENT_MODEL) {
        // 詳細なエラー情報を取得
        let detailError = 'APIキーが正しいことを確認してください。';
        try {
          const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          const listData = await listResponse.json();
          if (listData.error) {
            detailError = `API Error: ${listData.error.message || JSON.stringify(listData.error)}`;
          }
        } catch (e) {
          detailError = `Network Error: ${e.message}`;
        }

        return {
          success: false,
          error: `利用可能なGeminiモデルが見つかりませんでした。\n${detailError}`
        };
      } else {
        // モデルが見つかったらキャッシュに保存
        await saveCachedModel(CURRENT_MODEL);
      }
    }

    console.log(`🚀 GOOGLE-TRANSLATE-SPEED translation: ${texts.length} paragraphs using ${CURRENT_MODEL}`);

    // Google翻訳並み高速戦略：全て個別並列処理
    return await translateIndividuallyParallel(texts, apiKey, tabId);

  } catch (error) {
    console.error('Translation error:', error);
    return { success: false, error: `翻訳エラー: ${error.message}` };
  }
}


// 🚀 Google翻訳並み個別並列処理（超高速）
async function translateIndividuallyParallel(texts, apiKey, tabId = null) {
  const maxConcurrency = 4; // Google翻訳並みの並列数（15RPM制限内で最適）
  const retryAttempts = 2; // 失敗時のリトライ回数

  console.log(`⚡ INDIVIDUAL PARALLEL translation: ${texts.length} paragraphs, ${maxConcurrency} concurrent`);

  const allResults = [];
  const failedIndices = [];

  // 段落インデックスの配列を作成
  const indices = Array.from({length: texts.length}, (_, i) => i);

  // 並列処理
  for (let i = 0; i < indices.length; i += maxConcurrency) {
    const concurrentIndices = indices.slice(i, i + maxConcurrency);

    console.log(`⚡ Processing batch ${Math.floor(i/maxConcurrency) + 1}/${Math.ceil(indices.length/maxConcurrency)}: indices ${concurrentIndices[0]}-${concurrentIndices[concurrentIndices.length-1]}`);

    const promises = concurrentIndices.map(async (index) => {
      const text = texts[index];
      let attempts = 0;

      while (attempts < retryAttempts) {
        try {
          const result = await translateSingleFast(text, apiKey);

          if (result && result.length > 0) {
            // 即座にcontent scriptに送信（リアルタイム表示）
            if (tabId) {
              try {
                chrome.tabs.sendMessage(tabId, {
                  action: 'translationProgress',
                  startIndex: index,
                  translations: [result]
                });
              } catch (error) {
                console.warn(`Failed to send progress for index ${index}:`, error);
              }
            }

            console.log(`✅ Translated paragraph ${index + 1}: "${result.substring(0, 50)}..."`);
            return { index, result, success: true };
          } else {
            throw new Error('Empty translation result');
          }
        } catch (error) {
          attempts++;
          console.warn(`⚠️ Translation failed for paragraph ${index + 1}, attempt ${attempts}/${retryAttempts}:`, error.message);

          if (attempts < retryAttempts) {
            // 短い待機後にリトライ
            await new Promise(resolve => setTimeout(resolve, 200 * attempts));
          }
        }
      }

      // 全てのリトライが失敗した場合
      console.error(`❌ Failed to translate paragraph ${index + 1} after ${retryAttempts} attempts`);
      return { index, result: `[翻訳失敗] ${text.substring(0, 100)}...`, success: false };
    });

    try {
      const batchResults = await Promise.all(promises);

      // 結果を正しい順序で配列に格納
      for (const { index, result, success } of batchResults) {
        allResults[index] = result;
        if (!success) {
          failedIndices.push(index);
        }
      }

      console.log(`⚡ Batch completed: ${batchResults.filter(r => r.success).length}/${batchResults.length} successful`);

    } catch (error) {
      console.error('❌ Batch processing error:', error);

      // エラー時は失敗テキストで埋める
      for (const index of concurrentIndices) {
        if (allResults[index] === undefined) {
          allResults[index] = `[翻訳失敗] ${texts[index].substring(0, 100)}...`;
          failedIndices.push(index);
        }
      }
    }

    // バッチ間の短い待機（レート制限対策）
    if (i + maxConcurrency < indices.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // 結果の検証と調整
  const finalResults = [];
  for (let i = 0; i < texts.length; i++) {
    finalResults[i] = allResults[i] || `[翻訳失敗] ${texts[i].substring(0, 100)}...`;
  }

  const successRate = Math.round(((texts.length - failedIndices.length) / texts.length) * 100);
  console.log(`⚡ INDIVIDUAL PARALLEL COMPLETE: ${texts.length - failedIndices.length}/${texts.length} successful (${successRate}%)`);

  if (failedIndices.length > 0) {
    console.warn(`⚠️ Failed paragraphs: ${failedIndices.join(', ')}`);
  }

  return { success: true, translatedTexts: finalResults };
}

// 🚀 並列化バッチ処理（確実性重視）- 非推奨、個別処理に置き換え
async function translateInParallel(texts, apiKey, tabId = null) {
  // 個別並列処理にリダイレクト
  return await translateIndividuallyParallel(texts, apiKey, tabId);
}

  console.log(`🚀 PARALLEL translation: ${texts.length} texts, batch size ${batchSize}, max concurrent ${maxConcurrency}`);

  // バッチに分割
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({
      texts: texts.slice(i, i + batchSize),
      index: Math.floor(i / batchSize),
      total: Math.ceil(texts.length / batchSize)
    });
  }

  console.log(`📦 Created ${batches.length} batches for parallel processing`);

  const allResults = [];

  // 制限付き並列実行
  for (let i = 0; i < batches.length; i += maxConcurrency) {
    const concurrentBatches = batches.slice(i, i + maxConcurrency);

    console.log(`⚡ Parallel execution: processing ${concurrentBatches.length} batches simultaneously`);
    const startTime = performance.now();

    // 並列実行
    const promises = concurrentBatches.map(async (batch) => {
      console.log(`🔄 Starting batch ${batch.index + 1}/${batch.total}: ${batch.texts.length} texts`);
      const result = await translateBatchReliable(batch.texts, apiKey, tabId, batch.index * batchSize);
      console.log(`✅ Completed batch ${batch.index + 1}/${batch.total}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      return { ...result, batchIndex: batch.index };
    });

    try {
      const results = await Promise.all(promises);
      const executionTime = performance.now() - startTime;
      console.log(`⚡ Parallel batch group completed in ${executionTime.toFixed(2)}ms`);

      // 結果を処理
      for (const result of results) {
        if (result.success) {
          allResults.push(...result.translatedTexts);
        } else {
          console.error(`❌ Batch ${result.batchIndex + 1} failed:`, result.error);

          // 失敗したバッチを個別処理で救済
          console.log(`🔄 Retrying failed batch individually...`);
          const batch = batches[result.batchIndex];
          for (const text of batch.texts) {
            const individual = await translateSingle(text, apiKey, tabId);
            allResults.push(individual);
          }
        }
      }

    } catch (error) {
      console.error(`❌ Parallel execution error:`, error);

      // 完全失敗時は順次処理にフォールバック
      console.log(`🔄 Falling back to sequential processing...`);
      for (const batch of concurrentBatches) {
        const result = await translateBatchReliable(batch.texts, apiKey, tabId, batch.index * batchSize);
        if (result.success) {
          allResults.push(...result.translatedTexts);
        } else {
          // 最終手段：翻訳失敗表示
          allResults.push(...batch.texts.map(text => `[翻訳失敗] ${text.substring(0, 100)}...`));
        }
      }
    }
  }

  const completionRate = Math.round((allResults.length / texts.length) * 100);
  console.log(`🚀 PARALLEL COMPLETE: ${allResults.length}/${texts.length} translations (${completionRate}%)`);

  return { success: true, translatedTexts: allResults };
}

// ⚡ 中規模テキスト用の処理 - 個別並列処理にリダイレクト
async function translateInSmallParallel(texts, apiKey, tabId = null) {
  console.log(`⚡ SMALL PARALLEL redirecting to individual parallel processing`);
  return await translateIndividuallyParallel(texts, apiKey, tabId);
}

// バッチ処理（レガシー、個別並列処理にリダイレクト）
async function translateBatchReliable(texts, apiKey, tabId = null, startIndex = 0) {
  console.log(`🛡️ RELIABLE BATCH redirecting to individual parallel processing`);
  return await translateIndividuallyParallel(texts, apiKey, tabId);
}

// 🚀 高速単一翻訳（Google翻訳並み）
async function translateSingleFast(text, apiKey) {
  const requestBody = {
    contents: [{
      parts: [{
        text: `Translate to Japanese:\n\n${text}`
      }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512, // 短縮で高速化
      topP: 0.8
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CURRENT_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`API Error ${response.status}: ${errorData.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('No translation candidates returned');
  }

  if (data.candidates[0].finishReason === 'SAFETY') {
    throw new Error('Content blocked by safety filter');
  }

  if (!data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
    throw new Error('Empty translation content');
  }

  const translation = data.candidates[0].content.parts[0].text.trim();

  if (!translation || translation.length === 0) {
    throw new Error('Empty translation result');
  }

  return translation;
}

// 単一テキストの翻訳（レガシー関数、後方互換性のため残す）
async function translateSingle(text, apiKey, tabId = null) {
  return await translateSingleFast(text, apiKey);
}


// 軽量な繰り返し検出
function hasQuickRepetition(translatedTexts) {
  for (const text of translatedTexts) {
    // 3文字以上の明らかな繰り返しのみチェック
    if (text.includes('彼が彼が') || text.includes('です。です。') || /(.{4,}?)\1{3,}/.test(text)) {
      return true;
    }
  }
  return false;
}

// 再試行処理（レガシー、個別並列処理にリダイレクト）
async function retryTranslationOnce(texts, apiKey, tabId = null) {
  console.log(`🔄 Retry redirecting to individual parallel processing`);
  return await translateIndividuallyParallel(texts, apiKey, tabId);
}



// 繰り返しエラーの検出と修正
function fixRepetitionErrors(translatedTexts, originalTexts) {
  const fixedTexts = [];

  for (let i = 0; i < translatedTexts.length; i++) {
    let text = translatedTexts[i];

    // 明らかな繰り返しパターンを検出（3文字以上の連続繰り返し）
    const repetitionMatch = text.match(/(.{3,}?)\1{2,}/g);

    if (repetitionMatch) {
      console.warn(`Repetition detected: ${repetitionMatch[0].substring(0, 50)}...`);

      // 繰り返しの最初の部分だけを残す
      const cleanedText = text.replace(/(.{3,}?)\1{2,}/g, '$1');

      // 文章が不完全に終わっている場合の修正
      const lastSentence = cleanedText.split(/[。！？]/).pop();
      if (lastSentence && lastSentence.length > 10) {
        // 不完全な最後の文を除去
        const sentences = cleanedText.split(/([。！？])/);
        if (sentences.length > 2) {
          sentences.splice(-2); // 不完全な文と句読点を除去
          text = sentences.join('');
        } else {
          text = cleanedText;
        }
      } else {
        text = cleanedText;
      }
    }

    // 極端に短いまたは空の翻訳の場合は元テキストを使用
    if (text.trim().length < 5) {
      console.warn(`Translation too short, using original: ${originalTexts[i]?.substring(0, 50)}...`);
      text = originalTexts[i] || '翻訳できませんでした';
    }

    fixedTexts.push(text);
  }

  return fixedTexts;
}


// シンプルなモデル検出（直接テスト）
async function findAvailableModelSimple(apiKey) {
  // 2026年現在利用可能と思われるモデル名（options.jsと同期）
  const modelCandidates = [
    // 2026年最新モデル
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash-exp',
    'gemini-exp-1121',
    'gemini-exp-1114',

    // レガシーモデル（まだ利用可能な可能性）
    'gemini-1.5-pro-002',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-pro'
  ];

  console.log('Testing models for availability...');

  for (const model of modelCandidates) {
    try {
      console.log(`Testing model: ${model}`);

      // 直接generateContentでテスト（確実な方法）
      const testResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'test' }]
          }],
          generationConfig: { maxOutputTokens: 50 }
        })
      });

      // 200 OKまたは特定のエラーコードなら利用可能
      if (testResponse.ok) {
        console.log(`✅ Model ${model} is available and working`);
        return model;
      }

      // 404以外のエラー（認証エラーなど）なら、モデルは存在する
      const errorData = await testResponse.json();
      if (testResponse.status !== 404) {
        console.log(`✅ Model ${model} exists (status: ${testResponse.status})`);
        return model;
      }

      console.log(`❌ Model ${model} not found (404)`);
    } catch (error) {
      console.log(`❌ Model ${model} test failed:`, error.message);
      continue;
    }
  }

  console.error('No working models found');
  return null;
}


// 最後の手段：確実に動作する可能性のあるモデル名を試す
async function tryLastResortModels(apiKey) {
  const fallbackModels = [
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash-8b-exp-0827',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-exp-0827',
    'gemini-exp-1114'  // 実験的モデル
  ];

  console.log('Trying fallback models...');

  for (const model of fallbackModels) {
    try {
      const testResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'test' }] }],
          generationConfig: { maxOutputTokens: 50 }
        })
      });

      if (testResponse.status !== 404) {
        console.log(`Found fallback model: ${model}`);
        return model;
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

// APIキー取得
async function getApiKey() {
  try {
    const result = await chrome.storage.local.get(['geminiApiKey']);
    return result.geminiApiKey || null;
  } catch (error) {
    console.error('Failed to get API key:', error);
    return null;
  }
}

// キャッシュ機能
function hashUrl(url) {
  const normalizedUrl = url.split('?')[0].split('#')[0]; // クエリとフラグメントを除去
  let hash = 0;
  for (let i = 0; i < normalizedUrl.length; i++) {
    const char = normalizedUrl.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

async function saveCache(url, data) {
  try {
    const cacheKey = 'translation_cache_' + hashUrl(url);
    const cacheData = {
      url,
      data,
      timestamp: Date.now(),
      version: '1.0'
    };
    await chrome.storage.local.set({ [cacheKey]: cacheData });
    return true;
  } catch (error) {
    console.error('Failed to save cache:', error);
    return false;
  }
}

async function loadCache(url) {
  try {
    const cacheKey = 'translation_cache_' + hashUrl(url);
    const result = await chrome.storage.local.get([cacheKey]);
    if (result[cacheKey] && result[cacheKey].version === '1.0') {
      return result[cacheKey].data;
    }
    return null;
  } catch (error) {
    console.error('Failed to load cache:', error);
    return null;
  }
}

async function clearCacheForUrl(url) {
  try {
    const cacheKey = 'translation_cache_' + hashUrl(url);
    await chrome.storage.local.remove([cacheKey]);
    return true;
  } catch (error) {
    console.error('Failed to clear cache:', error);
    return false;
  }
}

// モデルキャッシュ管理
async function loadCachedModel() {
  try {
    const result = await chrome.storage.local.get(['cachedModel']);
    if (result.cachedModel) {
      CURRENT_MODEL = result.cachedModel;
      console.log('Loaded cached model:', CURRENT_MODEL);
    }
  } catch (error) {
    console.error('Failed to load cached model:', error);
  }
}

async function saveCachedModel(model) {
  try {
    await chrome.storage.local.set({ cachedModel: model });
    console.log('Saved model to cache:', model);
  } catch (error) {
    console.error('Failed to save cached model:', error);
  }
}

console.log('AI Web Novel Translator service worker started');