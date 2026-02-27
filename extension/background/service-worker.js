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

    console.log(`🚀 OPTIMIZED RELIABLE translation: ${texts.length} paragraphs using ${CURRENT_MODEL}`);

    // 確実性重視の翻訳戦略
    if (texts.length > 16) {
      return await translateInParallel(texts, apiKey, tabId);
    } else if (texts.length > 8) {
      // 中規模も小並列化
      return await translateInSmallParallel(texts, apiKey, tabId);
    }

    // 小規模は確実な単バッチ処理
    const result = await translateBatchReliable(texts, apiKey, tabId);

    // 品質チェック
    if (result.success && hasQuickRepetition(result.translatedTexts)) {
      console.warn('⚠️ Repetition detected, fixing...');
      return await retryTranslationOnce(texts, apiKey, tabId);
    }

    return result;

  } catch (error) {
    console.error('Translation error:', error);
    return { success: false, error: `翻訳エラー: ${error.message}` };
  }
}


// 🚀 並列化バッチ処理（確実性重視）
async function translateInParallel(texts, apiKey, tabId = null) {
  const batchSize = 8; // 確実性重視の小バッチサイズ

  // 並列数を2に固定（Gemini無料枠の15RPM制限対応）
  const maxConcurrency = 2;

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

// ⚡ 中規模テキスト用の小並列化処理
async function translateInSmallParallel(texts, apiKey, tabId = null) {
  const halfSize = Math.ceil(texts.length / 2);

  console.log(`⚡ SMALL PARALLEL translation: ${texts.length} texts in 2 parallel batches`);

  const batch1 = texts.slice(0, halfSize);
  const batch2 = texts.slice(halfSize);

  console.log(`📦 Batch 1: ${batch1.length} texts, Batch 2: ${batch2.length} texts`);

  try {
    const startTime = performance.now();

    // 2つのバッチを並列実行
    const [result1, result2] = await Promise.all([
      translateBatchReliable(batch1, apiKey, tabId, 0),
      translateBatchReliable(batch2, apiKey, tabId, halfSize)
    ]);

    const executionTime = performance.now() - startTime;
    console.log(`⚡ Small parallel execution completed in ${executionTime.toFixed(2)}ms`);

    const allResults = [];

    // 結果1を処理
    if (result1.success) {
      allResults.push(...result1.translatedTexts);
      console.log(`✅ Batch 1 success: ${result1.translatedTexts.length} translations`);
    } else {
      console.warn(`⚠️ Batch 1 failed, using fallback`);
      allResults.push(...batch1.map(text => `[翻訳失敗] ${text.substring(0, 100)}...`)); // フォールバック
    }

    // 結果2を処理
    if (result2.success) {
      allResults.push(...result2.translatedTexts);
      console.log(`✅ Batch 2 success: ${result2.translatedTexts.length} translations`);
    } else {
      console.warn(`⚠️ Batch 2 failed, using fallback`);
      allResults.push(...batch2.map(text => `[翻訳失敗] ${text.substring(0, 100)}...`)); // フォールバック
    }

    console.log(`⚡ SMALL PARALLEL COMPLETE: ${allResults.length}/${texts.length} translations`);
    return { success: true, translatedTexts: allResults };

  } catch (error) {
    console.error(`❌ Small parallel execution failed:`, error);

    // フォールバック：順次処理
    console.log(`🔄 Falling back to sequential processing...`);
    return await translateBatchReliable(texts, apiKey, tabId, 0);
  }
}

// 確実性重視のバッチ処理
async function translateBatchReliable(texts, apiKey, tabId = null, startIndex = 0) {
  console.log(`🛡️ RELIABLE BATCH: ${texts.length} texts`);

  const combinedText = texts.join('\n\n###TRANSLATE_SEPARATOR###\n\n');
  const estimatedTokens = combinedText.length * 0.25;

  // 小バッチ用の最適化トークン制限
  const safeMaxTokens = Math.min(8192, Math.max(2048, Math.round(estimatedTokens * 2.0)));
  console.log(`🛡️ Optimized token limit: ${safeMaxTokens} (estimated: ${Math.round(estimatedTokens)}, ratio: 2.0x)`);

  const requestBody = {
    contents: [{
      parts: [{
        text: SYSTEM_PROMPT + '\n\n' + combinedText
      }]
    }],
    generationConfig: {
      temperature: 0.2, // 少し高めで自然さ向上
      maxOutputTokens: safeMaxTokens,
      topP: 0.9,
      topK: 50
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CURRENT_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const data = await response.json();
      console.error(`❌ API Error ${response.status}:`, data);
      return { success: false, error: data.error?.message || `API Error ${response.status}` };
    }

    const data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      console.error(`❌ No candidates returned`);
      return { success: false, error: 'No translation candidates' };
    }

    const translatedText = data.candidates[0].content.parts[0].text.trim();
    console.log(`📝 Reliable translation length: ${translatedText.length} chars`);

    // 強化された分割処理
    let translatedTexts = [];

    // 主要分割方法: 新しい区切り文字
    const primarySplit = translatedText.split(/\n\n###TRANSLATE_SEPARATOR###\n\n/);
    translatedTexts = primarySplit.map(t => t.trim())
      .filter(t => t.length > 0)
      .filter(t => !t.includes('###TRANSLATE_SEPARATOR###')); // 残留区切り文字を除去

    console.log(`📊 Primary split result: ${translatedTexts.length} parts`);

    // 分割結果が少なすぎる場合の多段階フォールバック
    if (translatedTexts.length < texts.length * 0.6) {
      console.warn(`⚠️ Primary split insufficient (${translatedTexts.length}/${texts.length}), trying fallback methods`);

      // フォールバック1: ダブル改行
      const fallback1 = translatedText.split(/\n\s*\n/).map(t => t.trim()).filter(t => t.length > 10);
      if (fallback1.length > translatedTexts.length) {
        translatedTexts = fallback1;
        console.log(`✅ Fallback 1 better: ${translatedTexts.length} parts (double newline)`);
      }

      // フォールバック2: 段落番号を検出
      if (translatedTexts.length < texts.length * 0.6) {
        const fallback2 = translatedText.split(/(?=\d+\.|第\d+|Chapter|\n[A-Z]|\n「)/).map(t => t.trim()).filter(t => t.length > 5);
        if (fallback2.length > translatedTexts.length) {
          translatedTexts = fallback2;
          console.log(`✅ Fallback 2 better: ${translatedTexts.length} parts (paragraph detection)`);
        }
      }
    }

    // 区切り文字の残留を完全除去
    translatedTexts = translatedTexts.map(text =>
      text.replace(/###TRANSLATE_SEPARATOR###/g, '')
          .replace(/---SECTION---/g, '')
          .replace(/^[\s\n]+|[\s\n]+$/g, '')
    ).filter(t => t.length > 0);

    // 完全性チェック
    const completionRate = translatedTexts.length / texts.length;
    console.log(`📊 Completion rate: ${Math.round(completionRate * 100)}% (${translatedTexts.length}/${texts.length})`);

    // 結果調整
    while (translatedTexts.length < texts.length) {
      const missingIndex = translatedTexts.length;
      const fallback = `[未翻訳: ${texts[missingIndex]?.substring(0, 100)}...]`;
      translatedTexts.push(fallback);
    }

    if (translatedTexts.length > texts.length) {
      translatedTexts.splice(texts.length);
    }

    // 完了したバッチの進捗をcontent scriptに通知
    if (tabId && translatedTexts.length > 0) {
      try {
        chrome.tabs.sendMessage(tabId, {
          action: 'translationProgress',
          startIndex: startIndex,
          translations: translatedTexts
        });
        console.log(`📤 Sent progress update for batch: ${startIndex}-${startIndex + translatedTexts.length - 1}`);
      } catch (error) {
        console.warn('Failed to send progress update:', error);
      }
    }

    return { success: true, translatedTexts };

  } catch (error) {
    console.error(`❌ Network error in reliable batch:`, error);
    return { success: false, error: error.message };
  }
}

// 単一テキストの翻訳（最終手段）
async function translateSingle(text, apiKey, tabId = null) {
  console.log(`🎯 Single translation: ${text.substring(0, 50)}...`);

  const requestBody = {
    contents: [{
      parts: [{
        text: `以下の英語テキストを自然な日本語に翻訳してください：\n\n${text}`
      }]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      topP: 0.9
    }
  };

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CURRENT_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (response.ok) {
      const data = await response.json();
      if (data.candidates && data.candidates[0]) {
        const translation = data.candidates[0].content.parts[0].text.trim();
        console.log(`✅ Single translation success`);
        return translation;
      }
    }

    console.warn(`⚠️ Single translation failed, using original`);
    return text;

  } catch (error) {
    console.error(`❌ Single translation error:`, error);
    return text;
  }
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

// 1回のみの再試行（無限ループ防止）
async function retryTranslationOnce(texts, apiKey, tabId = null) {
  console.log(`🔄 Retrying translation for ${texts.length} texts (once only)`);

  // より保守的な設定で再試行
  const combinedText = texts.join('\n\n###TRANSLATE_SEPARATOR###\n\n');
  const requestBody = {
    contents: [{
      parts: [{
        text: `以下の英語テキストを日本語に翻訳してください。繰り返しは絶対禁止です：\n\n${combinedText}`
      }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16384,
      topP: 0.8
    }
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CURRENT_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (response.ok) {
    const data = await response.json();
    if (data.candidates && data.candidates[0]) {
      const translatedText = data.candidates[0].content.parts[0].text.trim();
      let translatedTexts = translatedText.split(/\n\n###TRANSLATE_SEPARATOR###\n\n/)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !t.includes('###TRANSLATE_SEPARATOR###'));

      // 結果調整
      while (translatedTexts.length < texts.length) {
        translatedTexts.push(texts[translatedTexts.length]);
      }
      if (translatedTexts.length > texts.length) {
        translatedTexts.splice(texts.length);
      }

      // 再試行成功時の進捗通知
      if (tabId && translatedTexts.length > 0) {
        try {
          chrome.tabs.sendMessage(tabId, {
            action: 'translationProgress',
            startIndex: 0,
            translations: translatedTexts
          });
          console.log(`📤 Sent retry progress update: ${translatedTexts.length} translations`);
        } catch (error) {
          console.warn('Failed to send retry progress update:', error);
        }
      }

      return { success: true, translatedTexts };
    }
  }

  // 再試行も失敗した場合は翻訳失敗テキストを返す
  console.warn('Retry failed, returning fallback texts');
  return { success: true, translatedTexts: texts.map(text => `[翻訳失敗] ${text.substring(0, 100)}...`) };
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