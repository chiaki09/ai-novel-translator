// Cache management for translated content
class TranslationCache {
  constructor() {
    this.cachePrefix = 'translation_cache_';
  }

  // URLをキーとして翻訳データを保存
  async saveCache(url, translatedData) {
    try {
      const cacheKey = this.cachePrefix + this.hashUrl(url);
      const cacheData = {
        url: url,
        translatedData: translatedData,
        timestamp: Date.now(),
        version: '1.0'
      };

      await chrome.storage.local.set({
        [cacheKey]: cacheData
      });

      console.log('Translation cached for:', url);
      return true;
    } catch (error) {
      console.error('Failed to save cache:', error);
      return false;
    }
  }

  // URLから翻訳データを取得
  async loadCache(url) {
    try {
      const cacheKey = this.cachePrefix + this.hashUrl(url);
      const result = await chrome.storage.local.get([cacheKey]);

      if (result[cacheKey]) {
        const cacheData = result[cacheKey];

        // バージョンチェック（将来的な互換性のため）
        if (cacheData.version !== '1.0') {
          console.log('Cache version mismatch, ignoring cache');
          return null;
        }

        console.log('Cache hit for:', url);
        return cacheData.translatedData;
      }

      console.log('Cache miss for:', url);
      return null;
    } catch (error) {
      console.error('Failed to load cache:', error);
      return null;
    }
  }

  // 特定URLのキャッシュを削除
  async clearCacheForUrl(url) {
    try {
      const cacheKey = this.cachePrefix + this.hashUrl(url);
      await chrome.storage.local.remove([cacheKey]);
      console.log('Cache cleared for:', url);
      return true;
    } catch (error) {
      console.error('Failed to clear cache:', error);
      return false;
    }
  }

  // 全キャッシュを削除
  async clearAllCache() {
    try {
      const allItems = await chrome.storage.local.get(null);
      const cacheKeys = Object.keys(allItems).filter(key =>
        key.startsWith(this.cachePrefix)
      );

      if (cacheKeys.length > 0) {
        await chrome.storage.local.remove(cacheKeys);
        console.log(`Cleared ${cacheKeys.length} cache entries`);
      }

      return true;
    } catch (error) {
      console.error('Failed to clear all cache:', error);
      return false;
    }
  }

  // キャッシュ統計情報を取得
  async getCacheStats() {
    try {
      const allItems = await chrome.storage.local.get(null);
      const cacheEntries = Object.entries(allItems).filter(([key, value]) =>
        key.startsWith(this.cachePrefix)
      );

      let totalSize = 0;
      let oldestEntry = null;
      let newestEntry = null;

      cacheEntries.forEach(([key, data]) => {
        totalSize += JSON.stringify(data).length;

        if (!oldestEntry || data.timestamp < oldestEntry.timestamp) {
          oldestEntry = data;
        }

        if (!newestEntry || data.timestamp > newestEntry.timestamp) {
          newestEntry = data;
        }
      });

      return {
        totalEntries: cacheEntries.length,
        totalSizeBytes: totalSize,
        oldestEntry: oldestEntry,
        newestEntry: newestEntry
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return null;
    }
  }

  // URLをハッシュ化（キーとして使用）
  hashUrl(url) {
    // シンプルなハッシュ関数（URLを正規化してからハッシュ化）
    const normalizedUrl = this.normalizeUrl(url);
    let hash = 0;

    for (let i = 0; i < normalizedUrl.length; i++) {
      const char = normalizedUrl.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit整数に変換
    }

    return Math.abs(hash).toString(16);
  }

  // URLを正規化（クエリパラメータやフラグメントを除外）
  normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol + '//' + urlObj.hostname + urlObj.pathname;
    } catch (error) {
      // URLパースに失敗した場合はそのまま返す
      return url;
    }
  }

  // キャッシュが存在するかチェック
  async hasCache(url) {
    const cacheData = await this.loadCache(url);
    return cacheData !== null;
  }
}

// グローバルインスタンス
const translationCache = new TranslationCache();