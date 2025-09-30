# TransPal Gemini Transcriber

使用 Google Gemini 進行音訊轉錄的工具，可自動產生逐字稿、摘要及時間戳記。

## 系統需求

- Node.js (v18 或以上)
- pnpm

## 安裝

```bash
# 安裝相依套件
pnpm install

# 設定環境變數
cp .env.example .env
```

請在 `.env` 中填入您的 Gemini API Key：

```bash
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-pro-exp-03-25
```

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

我們提供了兩個範例 prompt 檔案：

- `example-prompt.txt`：基礎增強版 prompt，加入情緒分析
- `advanced-prompt.txt`：專業級 prompt，適合正式會議或訪談

輸出會以 JSON 格式儲存，檔名為轉錄內容的英文 slug。

### 注意事項

- 建議輸入少於 30 分鐘的音訊檔案
- 目前時間戳記的準確度可能不夠理想，須等待更強大的模型或調整 prompt
- 使用自定義 prompt 時，請確保包含基本的轉錄要求（說話者、時間戳記等）
- 自定義 prompt 可以用來改善特定場景的轉錄品質，如會議記錄、訪談分析等

### Prompt 撰寫建議

- **明確指定輸出格式要求**：確保包含說話者、時間戳記等基本元素
- **加入特定領域知識**：根據音訊內容（如醫療、法律、技術討論）調整專業要求
- **指定語言風格**：標點符號規範、語調要求等
- **額外分析需求**：情緒分析、關鍵決策點標記、專業術語解釋等
- **品質控制**：要求完整性、準確性、邏輯連貫性

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
      "end": 10,
      "type": "speech",
      "speaker": "SPEAKER_01",
      "text": "說話內容"
    }
  ]
}
```

## License

ISC
