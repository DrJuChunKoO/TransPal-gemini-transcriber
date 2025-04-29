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

```bash
pnpm start <音訊檔案路徑>
```

輸出會以 JSON 格式儲存，檔名為轉錄內容的英文 slug。

### 注意事項

- 建議輸入少於 30 分鐘的音訊檔案
- 目前時間戳記的準確度可能不夠理想，須等待更強大的模型或調整 prompt

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
