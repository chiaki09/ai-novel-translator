document.addEventListener('DOMContentLoaded', function() {
  const apiKeyInput = document.getElementById('apiKey');
  const saveButton = document.getElementById('saveButton');
  const testButton = document.getElementById('testButton');
  const generateKeyButton = document.getElementById('generateKeyButton');
  const statusDiv = document.getElementById('status');
  const troubleshootingSection = document.getElementById('troubleshootingSection');
  const hideTroubleshootingButton = document.getElementById('hideTroubleshootingButton');

  // ページ読み込み時に保存済みAPIキーを取得
  loadSavedApiKey();

  // 保存ボタンのイベントリスナー
  saveButton.addEventListener('click', saveApiKey);

  // テストボタンのイベントリスナー
  testButton.addEventListener('click', testApiConnection);

  // APIキー生成ガイドボタン
  generateKeyButton.addEventListener('click', openApiKeyGuide);

  // トラブルシューティング非表示ボタン
  hideTroubleshootingButton.addEventListener('click', function() {
    troubleshootingSection.style.display = 'none';
  });

  // Enterキーでの保存
  apiKeyInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
      saveApiKey();
    }
  });

  async function loadSavedApiKey() {
    try {
      const result = await chrome.storage.local.get(['geminiApiKey']);
      if (result.geminiApiKey) {
        apiKeyInput.value = result.geminiApiKey;
      }
    } catch (error) {
      console.error('Failed to load API key:', error);
    }
  }

  async function saveApiKey() {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus('APIキーを入力してください', 'error');
      return;
    }

    // APIキーの形式を詳細チェック
    const keyValidation = validateApiKey(apiKey);
    if (!keyValidation.isValid) {
      showStatus(`❌ APIキー形式エラー:\n${keyValidation.error}\n\n💡 正しい形式: AIzaSyXXXX...（39文字）`, 'error');
      return;
    }

    try {
      await chrome.storage.local.set({ geminiApiKey: apiKey });
      showStatus('APIキーが正常に保存されました', 'success');

      // 保存後にテストボタンを有効化
      testButton.disabled = false;
    } catch (error) {
      console.error('Failed to save API key:', error);
      showStatus('APIキーの保存に失敗しました', 'error');
    }
  }

  async function testApiConnection() {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus('APIキーを入力してください', 'error');
      return;
    }

    // APIキーの形式をログ出力（セキュリティのため一部マスク）
    const maskedKey = apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4);
    console.log('Testing with API Key:', maskedKey, 'Length:', apiKey.length);

    showStatus('接続をテスト中...', 'info');
    testButton.disabled = true;

    try {
      // まず利用可能なモデル一覧を取得
      const availableModel = await findAvailableModelSimple(apiKey);

      if (!availableModel) {
        console.error('No models were available. Trying to get detailed error info...');

        // 詳細なエラー情報を取得
        const detailError = await getDetailedModelError(apiKey);
        showStatus(`❌ 利用可能なモデルが見つかりませんでした\n${detailError}`, 'error');
        return;
      }

      console.log('Using model:', availableModel);

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${availableModel}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: 'Hello, this is a test. Please respond with "Connection successful" in Japanese.'
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 200
          }
        })
      });

      const data = await response.json();

      console.log('API Response Status:', response.status);
      console.log('API Response Data:', data);

      if (response.ok && data.candidates && data.candidates[0]) {
        const responseText = data.candidates[0].content.parts[0].text;
        showStatus(`✅ 接続成功！\nモデル: ${availableModel}\nGeminiからの応答: "${responseText}"`, 'success');

        // トラブルシューティングセクションを隠す
        troubleshootingSection.style.display = 'none';

        // 利用可能モデル一覧もログに出力（デバッグ用）
        listAvailableModelsForDebug(apiKey);
      } else {
        console.error('API Error Details:', JSON.stringify(data, null, 2));

        let errorMessage = '不明なエラー';
        if (data.error) {
          if (typeof data.error === 'string') {
            errorMessage = data.error;
          } else if (data.error.message) {
            errorMessage = data.error.message;
          } else {
            errorMessage = JSON.stringify(data.error);
          }
        } else if (data.message) {
          errorMessage = data.message;
        }

        // APIキーエラーの場合は詳細なトラブルシューティングを表示
        if (response.status === 400 && errorMessage.includes('API key not valid')) {
          showStatus(`❌ APIキーが無効です\n\n下記のトラブルシューティングガイドを確認してください`, 'error');

          // トラブルシューティングセクションを表示
          troubleshootingSection.style.display = 'block';
          troubleshootingSection.scrollIntoView({ behavior: 'smooth' });

          // 詳細な診断情報をコンソールに出力
          console.group('🚨 APIキーエラー診断');
          console.log('1. APIキー形式: 正常 (AIzaで開始)');
          console.log('2. APIサービス到達: 成功');
          console.log('3. 認証ステータス: 失敗');
          console.log('4. エラー詳細:', errorMessage);
          console.log('5. 解決手順: トラブルシューティングセクションを参照');
          console.groupEnd();
        } else {
          showStatus(`❌ 接続失敗 (${response.status}): ${errorMessage}`, 'error');
        }
      }
    } catch (error) {
      console.error('Network error:', error);
      showStatus('❌ ネットワークエラー: インターネット接続を確認してください', 'error');
    } finally {
      testButton.disabled = false;
    }
  }

  async function findAvailableModelSimple(apiKey) {
    // 2026年現在利用可能と思われるモデル名（優先順位付き）
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

        // 直接generateContentでテスト
        const testResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: 'Hello, test connection' }]
            }],
            generationConfig: { maxOutputTokens: 50 }
          })
        });

        // レスポンス詳細をログ出力
        const responseData = await testResponse.json().catch(() => null);
        console.log(`Model ${model} - Status: ${testResponse.status}`, responseData);

        // 200 OKなら利用可能
        if (testResponse.ok) {
          console.log(`✅ Model ${model} is working`);
          return model;
        }

        // 404以外のエラー（認証、制限エラーなど）なら、モデルは存在する
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

    return null;
  }

  // 詳細なモデルエラー情報を取得
  async function getDetailedModelError(apiKey) {
    try {
      // models.list APIでエラー詳細を取得
      const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const listData = await listResponse.json();

      if (!listResponse.ok) {
        if (listData.error) {
          return `API Error: ${JSON.stringify(listData.error)}`;
        } else {
          return `HTTP Error: ${listResponse.status} ${listResponse.statusText}`;
        }
      }

      if (!listData.models || listData.models.length === 0) {
        return 'APIは正常だが利用可能なモデルがありません';
      }

      return `APIは正常、${listData.models.length}個のモデルが利用可能だが、generateContentをサポートするものがありませんでした`;

    } catch (error) {
      return `Network Error: ${error.message}`;
    }
  }

  // APIキーの形式を詳細検証
  function validateApiKey(apiKey) {
    if (!apiKey || apiKey.trim() === '') {
      return { isValid: false, error: 'APIキーが入力されていません' };
    }

    apiKey = apiKey.trim();

    if (!apiKey.startsWith('AIza')) {
      return {
        isValid: false,
        error: 'APIキーは"AIza"で始まる必要があります\n現在の開始: ' + apiKey.substring(0, 10) + '...'
      };
    }

    if (apiKey.length < 35 || apiKey.length > 45) {
      return {
        isValid: false,
        error: `APIキーの長さが不正です (${apiKey.length}文字)\n正常な長さ: 39文字程度`
      };
    }

    // 不正な文字が含まれていないかチェック
    const validChars = /^[A-Za-z0-9\-_]+$/;
    if (!validChars.test(apiKey)) {
      return {
        isValid: false,
        error: 'APIキーに不正な文字が含まれています\n使用可能文字: A-Z, a-z, 0-9, -, _'
      };
    }

    return { isValid: true };
  }

  // APIキー生成ガイドを開く
  function openApiKeyGuide() {
    // Google AI Studioを新しいタブで開く
    window.open('https://aistudio.google.com/apikey', '_blank');

    // 詳細な手順をステータスに表示
    showStatus(`🔑 Google AI Studioが開きました\n\n📋 手順:\n1. 「Create API Key」をクリック\n2. 新しいプロジェクトを選択または作成\n3. 生成されたAPIキーをコピー\n4. このページに戻って貼り付け\n5. 「保存」→「接続テスト」を実行`, 'info');

    // コンソールにも詳細な手順を出力
    console.group('🔑 APIキー生成手順');
    console.log('1. Google AI Studio が開かれました: https://aistudio.google.com/apikey');
    console.log('2. 「Create API Key」ボタンをクリック');
    console.log('3. プロジェクトを選択（新規作成も可能）');
    console.log('4. 生成されたAPIキー（AIzaで始まる文字列）をコピー');
    console.log('5. この設定画面に戻って「Gemini API Key」フィールドに貼り付け');
    console.log('6. 「保存」ボタンをクリック');
    console.log('7. 「接続テスト」ボタンでテスト実行');
    console.log('\n💡 注意点:');
    console.log('- APIキーは他人に知らせないでください');
    console.log('- 使用制限を適切に設定してください');
    console.log('- Gemini API for Developers が有効になっていることを確認');
    console.groupEnd();
  }

  // デバッグ用：利用可能なモデル一覧をログに出力
  async function listAvailableModelsForDebug(apiKey) {
    try {
      const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (listResponse.ok) {
        const listData = await listResponse.json();
        console.group('🤖 Available Gemini Models (Debug Info):');
        if (listData.models) {
          listData.models.forEach(model => {
            console.log(`📋 ${model.name}:`, {
              supportedMethods: model.supportedGenerationMethods,
              inputTokenLimit: model.inputTokenLimit,
              outputTokenLimit: model.outputTokenLimit
            });
          });
        }
        console.groupEnd();
      }
    } catch (error) {
      console.log('Could not fetch model list for debug:', error);
    }
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';

    // 成功メッセージは3秒後に自動で隠す
    if (type === 'success') {
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 3000);
    }
  }
});