import "dotenv/config";
import path from "path";
import { writeFile } from "fs/promises";
import { GoogleGenAI } from "@google/genai";
import { v4 as uuidv4 } from "uuid";

// 初始化 Google AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function processAudioFile(filePath) {
  // 從檔案路徑取得檔案名稱
  const fileName = path.basename(filePath);
  const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");

  // 上傳檔案
  console.log("上傳音訊檔案中...");
  const uploadedFile = await ai.files.upload({
    file: filePath,
    config: { mimeType: "audio/mp4" },
  });

  console.log("檔案上傳成功");

  // 使用 Gemini 生成內容
  const result = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `請分析這段音訊並產生逐字稿。請注意：
1. 需要包含說話者、開始時間和結束時間
2. 若無法從音訊中辨識出說話者，請以 SPEAKER_01 依序編號
3. 請根據內容產生適當的標題
4. 請產生適合用於網址的英文 slug
5. summary 支援 Markdown 格式，列出 4-6 個重點討論內容，可以使用粗體、斜體、列表等進行強調和排版
6. 標點符號請使用繁體中文（台灣）的標點符號，像是：，。？！「」、
7. 若單個對話過長，請適當分割
8. 請不要偷懶，這是個很重要的工作，請完成所有音訊對話的辨識`,
          },
          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType,
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "根據內容產生的中文標題",
          },
          slug: {
            type: "string",
            description:
              "根據標題產生的英文 URL slug，只能包含小寫英文字母、數字和連字號",
          },
          transcription: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: {
                  type: "string",
                  description: "說話者名稱",
                },
                startTime: {
                  type: "number",
                  description: "開始時間（秒）",
                },
                endTime: {
                  type: "number",
                  description: "結束時間（秒）",
                },
                text: {
                  type: "string",
                  description: "說話內容",
                },
              },
              required: ["speaker", "startTime", "endTime", "text"],
            },
          },
          summary: {
            type: "string",
            description: "對話內容摘要",
          },
        },
        required: ["title", "slug", "transcription", "summary"],
      },
    },
  });
  // 處理回應並格式化
  const transcription = await processTranscription(
    result.candidates[0].content.parts[0].text,
    nameWithoutExt
  );
  return transcription;
}

function processTranscription(rawResponse, fileName) {
  try {
    const response = JSON.parse(rawResponse);
    const today = new Date();
    const formattedDate = today.toISOString().split("T")[0];

    return {
      info: {
        filename: fileName,
        name: response.title,
        slug: response.slug,
        date: formattedDate,
        description: `為 Gemini 轉錄，有錯誤歡迎留言分享\n\n${response.summary}`,
      },
      content: response.transcription.map((item) => ({
        id: uuidv4(),
        start: item.startTime,
        end: item.endTime,
        type: "speech",
        speaker: item.speaker,
        text: item.text,
      })),
    };
  } catch (error) {
    console.error("解析 JSON 回應失敗：", error);
    // 如果解析失敗，返回原始格式
    return {
      info: {
        filename: fileName + ".m4a",
        name: fileName,
        slug: fileName.toLowerCase().replace(/\s+/g, "-"),
        date: formattedDate,
        description: "為 Gemini 轉錄，有錯誤歡迎留言分享\n\n" + rawResponse,
      },
      content: [
        {
          id: uuidv4(),
          start: 0,
          end: 0,
          type: "speech",
          speaker: "待處理",
          text: rawResponse,
        },
      ],
    };
  }
}

async function main() {
  try {
    const mediaPath = process.argv[2];
    if (!mediaPath) {
      throw new Error("請提供音訊檔案路徑");
    }

    const result = await processAudioFile(mediaPath);

    // 將結果寫入檔案
    const outputPath = `${result.info.slug}.json`;
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`已將轉錄結果儲存至：${outputPath}`);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}

main();
