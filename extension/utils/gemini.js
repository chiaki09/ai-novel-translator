// Gemini API wrapper for Chrome Extension
class GeminiTranslator {
  constructor() {
    this.apiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
    this.systemPrompt = `あなたはWeb小説の翻訳者です。以下のルールに従って日本語に翻訳してください。
- 自然で読みやすい日本語にする（直訳NG）
- キャラクターの口調・個性を維持する
- 人名・地名・スキル名はカタカナ表記を基本とする
- 段落構造をそのまま維持する
- 翻訳結果のみ返す（説明文・コメント不要）
- 各段落は元と同じ順序・数で返す

以下のテキストを翻訳してください：`;
  }

  async getApiKey() {
    try {
      const result = await chrome.storage.local.get(['geminiApiKey']);
      return result.geminiApiKey || null;
    } catch (error) {
      console.error('Failed to get API key:', error);
      return null;
    }
  }

  async translateText(text) {
    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: 'テキストが空です'
      };
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return {
        success: false,
        error: 'APIキーが設定されていません。設定画面でAPIキーを入力してください。',
        needsApiKey: true
      };
    }

    try {
      const requestBody = {
        contents: [{
          parts: [{
            text: this.systemPrompt + '\n\n' + text
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          topP: 0.8,
          topK: 40
        },
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_NONE'
          },
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_NONE'
          },
          {
            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            threshold: 'BLOCK_NONE'
          },
          {
            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            threshold: 'BLOCK_NONE'
          }
        ]
      };

      const response = await fetch(`${this.apiEndpoint}?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (!response.ok) {
        let errorMessage = 'API error occurred';

        if (data.error) {
          errorMessage = data.error.message;

          if (data.error.code === 400) {
            errorMessage = 'APIリクエストが無効です。APIキーを確認してください。';
          } else if (data.error.code === 403) {
            errorMessage = 'APIキーが無効です。設定画面で正しいAPIキーを入力してください。';
          } else if (data.error.code === 429) {
            errorMessage = 'API使用制限に達しました。しばらく待ってから再試行してください。';
          }
        }

        return {
          success: false,
          error: errorMessage
        };
      }

      if (!data.candidates || data.candidates.length === 0) {
        return {
          success: false,
          error: '翻訳結果を取得できませんでした'
        };
      }

      const candidate = data.candidates[0];

      if (candidate.finishReason === 'SAFETY') {
        return {
          success: false,
          error: 'コンテンツがセーフティフィルターに引っかかりました'
        };
      }

      if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
        return {
          success: false,
          error: '翻訳結果が空です'
        };
      }

      const translatedText = candidate.content.parts[0].text.trim();

      return {
        success: true,
        translatedText: translatedText,
        usage: data.usageMetadata || {}
      };

    } catch (error) {
      console.error('Translation error:', error);

      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        return {
          success: false,
          error: 'ネットワークエラー: インターネット接続を確認してください'
        };
      }

      return {
        success: false,
        error: `翻訳エラー: ${error.message}`
      };
    }
  }

  async translateParagraphs(paragraphs) {
    if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
      return {
        success: false,
        error: '翻訳対象の段落が見つかりません'
      };
    }

    // 段落をまとめて翻訳リクエストを送信
    const combinedText = paragraphs.join('\n\n---\n\n');
    const result = await this.translateText(combinedText);

    if (!result.success) {
      return result;
    }

    // 翻訳結果を段落ごとに分割
    const translatedParagraphs = result.translatedText.split(/\n\n---\n\n|\n---\n/).map(p => p.trim()).filter(p => p.length > 0);

    return {
      success: true,
      translatedParagraphs: translatedParagraphs,
      usage: result.usage
    };
  }
}

// グローバルインスタンス
const geminiTranslator = new GeminiTranslator();