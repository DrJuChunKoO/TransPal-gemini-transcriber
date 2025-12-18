# TransPal Transcriber

使用 Gemini、OpenRouter 和 AI SDK 進行音訊轉錄的工具，專為長音檔設計，可自動產生逐字稿、摘要及時間戳記。

## 特色

- **長音訊支援**：自動將長音檔分割為 5 分鐘的小片段進行處理，解決模型 token 限制與偷懶問題。
- **上下文感知**：在轉錄每個片段時，會參考上一段的內容與已知說話者，確保語意與角色連貫。
- **全域說話者統一**：轉錄完成後，AI 會分析完整內容，自動將不一致的稱呼（如 "SPEAKER_01"）統一為真實姓名。
- **結構化輸出**：使用 AI SDK 的 `generateText` 搭配 `Output.object`，確保輸出穩定的 JSON 格式。
- **自動重試機制**：遇到 API 錯誤時會自動重試，提升穩定性。

## 為什麼選擇 Gemini？

比起 Whisper，使用 Gemini 進行轉錄雖然成本較高，但對於中文的轉譯品質有巨大的進步（例如使用 `google/gemini-3-flash-preview` 轉錄一小時音檔約僅需 $0.16 USD），特別體現在：

- **成語與慣用語**的精確辨識
- **特殊領域名詞**（如科技、醫療、法律）的正確率
- **語意連貫性**與標點符號的自然程度
- **多人同時說話**時，對重疊音訊的強大辨識與區分能力

## 系統需求

- Node.js (v22.18.0 或以上)
- pnpm
- **ffmpeg** (必須安裝並加入系統 PATH，用於音訊分割)

## 安裝

```bash
# 安裝相依套件
pnpm install

# 設定環境變數
cp .env.example .env
```

請在 `.env` 中填入您的 OpenRouter API Key：

```bash
OPENROUTER_API_KEY=your_api_key_here
OPENROUTER_MODEL=google/gemini-3-pro-preview
```

> 建議使用 `google/gemini-3-pro-preview` 或 `google/gemini-3-flash-preview` 以取得最佳轉錄品質。

## 使用方式

### 基本使用

```bash
pnpm start <音訊檔案路徑>
```

### 使用自定義 Prompt

你可以透過以下方式使用自定義 prompt 來改善轉錄品質：

```bash
# 使用命令行提供的 prompt
pnpm start <音訊檔案路徑> --prompt "你的自定義 prompt"

# 從檔案讀取 prompt
pnpm start <音訊檔案路徑> --prompt-file custom-prompt.txt
```

### 使用範例

```bash
# 基本使用
pnpm start recording.mp4

# 使用自定義 prompt 強調情緒分析
pnpm start interview.mp4 --prompt "請分析音訊並特別注意講者的情緒變化和語調，在逐字稿中標註重要的情緒轉折點"

# 使用檔案中的 prompt
pnpm start meeting.mp4 --prompt-file example-prompt.txt
```

輸出會以 TransPal JSON 格式儲存，檔名為轉錄內容的英文 slug。

## 輸出格式

```json
{
  "info": {
    "filename": "原始檔名",
    "name": "標題",
    "slug": "url-slug",
    "date": "2024-03-25",
    "description": "描述與摘要"
  },
  "content": [
    {
      "id": "uuid",
      "start": 0,
      "end": 300,
      "type": "speech",
      "speaker": "葛如鈞委員",
      "text": "說話內容..."
    }
  ]
}
```

## 技術架構

本專案使用最新的 AI SDK 架構：

- **核心邏輯**：
  1.  **分割**：使用 `ffmpeg` 將音訊切分為 300 秒片段。
  2.  **轉錄**：逐段呼叫 AI 進行轉錄，並傳入前文摘要以維持連貫性。
  3.  **正規化**：所有片段完成後，將完整逐字稿送回 AI 進行說話者身分分析與統一。
  4.  **摘要**：生成標題與重點摘要。
- **工具庫**：
  - `ai`: AI SDK Core (v6)
  - `zod`: 資料驗證與 Schema 定義

## License

MIT
