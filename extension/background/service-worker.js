// AI Web Novel Translator - Streaming Service Worker

// 定数
const MODEL_CANDIDATES = [
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];

const PROMPT = 'Translate to Japanese:';

// モデル初期化（キャッシュされたモデルを取得または検出）
async function getModel(apiKey) {
  const result = await chrome.storage.local.get(['cachedModel']);
  if (result.cachedModel) {
    return result.cachedModel;
  }

  for (const model of MODEL_CANDIDATES) {
    try {
      const testResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'test' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      });

      if (testResponse.ok || testResponse.status !== 404) {
        await chrome.storage.local.set({ cachedModel: model });
        return model;
      }
    } catch (error) {
      continue;
    }
  }

  throw new Error('No available Gemini model found');
}

// ストリーミング段落翻訳
async function streamParagraph(text, index, apiKey, tabId) {
  const model = await getModel(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const requestBody = {
    contents: [{ parts: [{ text: `${PROMPT}\n\n${text}` }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
      topP: 0.8
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`API Error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;

            const data = JSON.parse(jsonStr);
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
              result += text;
              chrome.tabs.sendMessage(tabId, {
                action: 'streamChunk',
                index,
                chunk: text,
                done: false
              });
            }
          } catch (parseError) {
            // Ignore parsing errors for malformed chunks
          }
        }
      }
    }

    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      index,
      chunk: '',
      done: true
    });

    return result || text;

  } catch (error) {
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      index,
      chunk: '[翻訳失敗]',
      done: true
    });
    throw error;
  }
}

// 並列翻訳制御（最大2並列）
async function translateTexts(texts, apiKey, tabId) {
  const maxConcurrency = 2;
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += maxConcurrency) {
    const batch = texts.slice(i, i + maxConcurrency);
    const promises = batch.map(async (text, localIndex) => {
      const globalIndex = i + localIndex;
      let attempts = 0;

      while (attempts < 2) {
        try {
          const result = await streamParagraph(text, globalIndex, apiKey, tabId);
          return { index: globalIndex, result, success: true };
        } catch (error) {
          attempts++;
          if (error.message.includes('429') && attempts < 2) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          return {
            index: globalIndex,
            result: `[翻訳失敗] ${text.substring(0, 100)}...`,
            success: false
          };
        }
      }
    });

    const batchResults = await Promise.all(promises);
    batchResults.forEach(({ index, result }) => {
      results[index] = result;
    });

    // Rate limit prevention
    if (i + maxConcurrency < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return { success: true, translatedTexts: results };
}

// SSEチャンクパース（予備、現在は直接パース）
function parseSSEChunk(uint8Array) {
  try {
    const text = new TextDecoder().decode(uint8Array);
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') return null;

        const data = JSON.parse(jsonStr);
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

// APIキー取得
async function getApiKey() {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  return result.geminiApiKey || null;
}

// キャッシュ機能
function hashUrl(url) {
  const normalizedUrl = url.split('?')[0].split('#')[0];
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
    const cacheData = { url, data, timestamp: Date.now(), version: '1.0' };
    await chrome.storage.local.set({ [cacheKey]: cacheData });
    return true;
  } catch (error) {
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
    return null;
  }
}

async function clearCacheForUrl(url) {
  try {
    const cacheKey = 'translation_cache_' + hashUrl(url);
    await chrome.storage.local.remove([cacheKey]);
    return true;
  } catch (error) {
    return false;
  }
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.action) {
      case 'translateText':
        const apiKey = await getApiKey();
        if (!apiKey) {
          sendResponse({
            success: false,
            error: 'APIキーが設定されていません',
            needsApiKey: true
          });
          return;
        }
        const result = await translateTexts(message.texts, apiKey, sender.tab?.id);
        sendResponse(result);
        break;

      case 'loadCache':
        const cacheData = await loadCache(message.url);
        sendResponse({ success: true, data: cacheData });
        break;

      case 'saveCache':
        const saveResult = await saveCache(message.url, message.data);
        sendResponse({ success: saveResult });
        break;

      case 'clearCache':
        const clearResult = await clearCacheForUrl(message.url);
        sendResponse({ success: clearResult });
        break;

      case 'clearCachedModel':
        await chrome.storage.local.remove(['cachedModel']);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 拡張機能インストール時
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});