import "dotenv/config";
import path from "path";
import { writeFile, readFile, mkdir, rm, readdir } from "fs/promises";
import { generateText, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import crypto from "crypto";

const execAsync = promisify(exec);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 初始化 OpenRouter 提供者
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// 定義單個轉錄項目的 schema
const transcriptionItemSchema = z.object({
  speaker: z.string().describe("說話者名稱"),
  startTime: z.number().describe("開始時間（秒），相對於本片段開始"),
  endTime: z.number().describe("結束時間（秒），相對於本片段開始"),
  text: z.string().describe("說話內容"),
});

// 定義轉錄結果的 Zod schema
const transcriptionSchema = z.array(transcriptionItemSchema);

type accumulatedResultsType = {
  title: string;
  slug: string;
  transcription: Array<{
    startTime: number;
    endTime: number;
    speaker: string;
    text: string;
  }>;
  summary: string;
};

// 分割音訊檔案
async function splitAudio(
  filePath: string,
  outputDir: string,
  segmentTime: number = 300
) {
  await mkdir(outputDir, { recursive: true });

  // 使用 ffmpeg 分割音訊
  // -f segment: 使用 segment muxer
  // -segment_time: 分割時間（秒）
  // -c:a libmp3lame: 重新編碼為 mp3 以確保相容性
  // -b:a 128k: 設定位元率
  const outputPattern = path.join(outputDir, "chunk_%03d.mp3");
  const command = `ffmpeg -i "${filePath}" -f segment -segment_time ${segmentTime} -c:a libmp3lame -b:a 128k "${outputPattern}"`;

  console.log(`正在分割音訊檔案，每段 ${segmentTime} 秒...`);
  await execAsync(command);

  const files = await readdir(outputDir);
  return files
    .filter((f) => f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(outputDir, f));
}

async function transcribeChunk(
  chunkPath: string,
  chunkIndex: number,
  previousContext: string,
  knownSpeakers: string[],
  customPrompt: string | null,
  promptTemplate: string
) {
  console.log(`正在轉錄第 ${chunkIndex + 1} 個片段...`);
  const fileData = await readFile(chunkPath);

  const systemPrompt = promptTemplate
    .replace(
      "{{knownSpeakers}}",
      knownSpeakers.length > 0 ? knownSpeakers.join(", ") : "尚無"
    )
    .replace("{{previousContext}}", previousContext || "尚無")
    .replace(
      "{{customPrompt}}",
      customPrompt ? `額外要求：${customPrompt}` : ""
    );

  let retries = 3;
  while (retries > 0) {
    try {
      const { output } = await generateText({
        model: openrouter(
          process.env.OPENROUTER_MODEL || "google/gemini-2.5-pro"
        ),
        output: Output.object({
          schema: z.object({
            transcription: transcriptionSchema,
          }),
        }),
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: [
              {
                type: "file",
                data: fileData,
                mediaType: "audio/mp3",
              },
              {
                type: "text",
                text: "請轉錄這個音訊片段。",
              },
            ],
          },
        ],
      });

      return output.transcription;
    } catch (error) {
      console.error(`轉錄失敗，剩餘重試次數：${retries - 1}`, error);
      retries--;
      if (retries === 0) throw error;
      await delay(2000);
    }
  }
  throw new Error("轉錄失敗，已達最大重試次數");
}

async function normalizeSpeakers(accumulatedResults: accumulatedResultsType) {
  console.log("正在進行說話者統一與正規化...");
  const transcriptionText = JSON.stringify(accumulatedResults.transcription);

  const { output } = await generateText({
    model: openrouter(process.env.OPENROUTER_MODEL || "google/gemini-2.5-pro"),
    output: Output.object({
      schema: z.object({
        mapping: z
          .record(z.string(), z.string())
          .describe("原始名稱 -> 統一後名稱 的對照表"),
      }),
    }),
    messages: [
      {
        role: "system",
        content: `請分析以下逐字稿的所有說話者。
請根據對話內容（自我介紹、稱呼等）推斷說話者的真實身分。
請將重複或不一致的稱呼（例如 "SPEAKER_01" 和 "王小明" 若為同一人）統一為最合適的名稱。
回傳一個 JSON 物件，鍵（key）為逐字稿中出現的原始名稱，值（value）為統一後的名稱。
若名稱無需變更，則值與鍵相同即可。`,
      },
      {
        role: "user",
        content: `逐字稿內容：${transcriptionText.slice(0, 1000000)}`, // 1M chars limit
      },
    ],
  });

  console.log("說話者對照表：", output.mapping);

  // Apply mapping
  const newTranscription = accumulatedResults.transcription.map((item) => ({
    ...item,
    speaker: output.mapping[item.speaker] || item.speaker,
  }));

  return {
    ...accumulatedResults,
    transcription: newTranscription,
  };
}

async function processAudioFile(
  filePath: string,
  customPrompt: string | null = null
) {
  const promptTemplate = await readFile(
    path.join(process.cwd(), "prompt.md"),
    "utf8"
  );
  const fileName = path.basename(filePath);
  const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");

  // 建立暫存目錄
  const tempDir = path.join(process.cwd(), "temp_chunks_" + Date.now());

  let accumulatedResults: accumulatedResultsType = {
    title: "",
    slug: "",
    transcription: [],
    summary: "",
  };

  try {
    // 1. 分割音訊
    const chunkPaths = await splitAudio(filePath, tempDir, 300); // 5分鐘一段
    console.log(`共分割為 ${chunkPaths.length} 個片段`);

    const knownSpeakers = new Set<string>();

    // 2. 逐段轉錄
    for (let i = 0; i < chunkPaths.length; i++) {
      const chunkPath = chunkPaths[i];

      // 準備上下文：取最後 10 筆轉錄作為參考
      const lastFewItems = accumulatedResults.transcription.slice(-10);
      const previousContext = lastFewItems
        .map((item) => `${item.speaker}: ${item.text}`)
        .join("\n");

      // 轉錄該片段
      const chunkTranscription = await transcribeChunk(
        chunkPath,
        i,
        previousContext,
        Array.from(knownSpeakers),
        customPrompt,
        promptTemplate
      );

      // 處理轉錄結果
      const timeOffset = i * 300; // 每一段的偏移量（秒）

      for (const item of chunkTranscription) {
        // 更新已知說話者
        knownSpeakers.add(item.speaker);

        // 加入結果並調整時間
        accumulatedResults.transcription.push({
          ...item,
          startTime: item.startTime + timeOffset,
          endTime: item.endTime + timeOffset,
        });
      }

      console.log(
        `片段 ${i + 1} 完成，目前累積 ${
          accumulatedResults.transcription.length
        } 句轉錄`
      );
    }

    // 3. 說話者統一與正規化
    accumulatedResults = await normalizeSpeakers(accumulatedResults);

    // 4. 生成標題與摘要
    accumulatedResults = await generateTitleAndSummary(accumulatedResults);

    // 5. 格式化最終結果
    const transcription = processTranscription(
      accumulatedResults,
      nameWithoutExt
    );

    return transcription;
  } catch (error: any) {
    console.error("處理過程中發生錯誤：", error);
    throw error;
  } finally {
    // 清理暫存檔案
    try {
      await rm(tempDir, { recursive: true, force: true });
      console.log("已清理暫存檔案");
    } catch (e) {
      console.error("清理暫存檔案失敗：", e);
    }
  }
}

async function generateTitleAndSummary(
  accumulatedResults: accumulatedResultsType
) {
  console.log("正在生成標題與摘要...");

  // 為了避免 context 過長，只取前 200 句和後 100 句作為摘要參考，或者隨機取樣
  // 但 Gemini context 很大，直接丟全部通常沒問題，除非真的超級長
  // 這裡先丟全部，如果真的太長可以考慮截斷
  const transcriptionText = JSON.stringify(accumulatedResults.transcription);

  const { output } = await generateText({
    model: openrouter(process.env.OPENROUTER_MODEL || "google/gemini-2.5-pro"),
    output: Output.object({
      schema: z.object({
        title: z.string().describe("根據內容產生的中文標題"),
        slug: z
          .string()
          .describe(
            "根據標題產生的英文 URL slug，只能包含小寫英文字母、數字和連字號"
          ),
        summary: z
          .string()
          .describe(
            "對話內容摘要，支援 Markdown 格式，列出 4-6 個重點討論內容"
          ),
      }),
    }),
    messages: [
      {
        role: "system",
        content: `請根據以下逐字稿內容，產生一個貼切的中文標題、一個適合用於網址的英文 slug（全小寫、以 - 連接），以及一段對話內容摘要（支援 Markdown 格式，列出 4-6 個重點討論內容）。`,
      },
      {
        role: "user",
        content: `逐字稿內容：${transcriptionText.slice(0, 500000)}`, // 簡單截斷以防萬一，但 500k 字元通常夠了
      },
    ],
  });

  console.log(`生成標題：${output.title}`);
  console.log(`生成 slug：${output.slug}`);
  console.log(`生成摘要：${output.summary}`);

  return {
    ...accumulatedResults,
    title: output.title,
    slug: output.slug,
    summary: output.summary,
  };
}

function processTranscription(
  response: {
    title: string;
    slug: string;
    transcription: Array<{
      startTime: number;
      endTime: number;
      speaker: string;
      text: string;
    }>;
    summary: string;
  },
  fileName: string
) {
  try {
    const today = new Date();
    const formattedDate = today.toISOString().split("T")[0];

    return {
      info: {
        filename: fileName,
        name: response.title,
        slug: response.slug,
        date: formattedDate,
        description: `${response.summary}\n\n為 Gemini 轉錄，有錯誤歡迎留言分享`,
      },
      content: response.transcription.map((item) => ({
        id: crypto.randomUUID(),
        start: item.startTime,
        end: item.endTime,
        type: "speech",
        speaker: item.speaker,
        text: item.text,
      })),
    };
  } catch (error) {
    console.error("處理轉錄結果時發生錯誤：", error);
    // 如果處理失敗，返回錯誤格式
    const today = new Date();
    const formattedDate = today.toISOString().split("T")[0];

    return {
      info: {
        filename: fileName + ".m4a",
        name: fileName,
        slug: fileName.toLowerCase().replace(/\s+/g, "-"),
        date: formattedDate,
        description: `為 Gemini 轉錄，有錯誤歡迎留言分享`,
      },
      content: [
        {
          id: crypto.randomUUID(),
          start: 0,
          end: 0,
          type: "speech",
          speaker: "待處理",
          text: "轉錄處理失敗，請檢查音訊檔案格式或 API 設定",
        },
      ],
    };
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const mediaPath = args[0];

    if (!mediaPath) {
      console.log("使用方式：");
      console.log("  pnpm start <音訊檔案路徑> [--prompt <自定義prompt>]");
      console.log(
        "  pnpm start <音訊檔案路徑> [--prompt-file <prompt檔案路徑>]"
      );
      console.log("");
      console.log("範例：");
      console.log("  pnpm start audio.mp4");
      console.log(
        "  pnpm start audio.mp4 --prompt '請產生詳細的逐字稿並分析講者情緒'"
      );
      console.log("  pnpm start audio.mp4 --prompt-file custom-prompt.txt");
      throw new Error("請提供音訊檔案路徑");
    }

    let customPrompt = null;

    // 解析命令行參數
    const promptIndex = args.indexOf("--prompt");
    const promptFileIndex = args.indexOf("--prompt-file");

    if (promptIndex !== -1 && promptIndex + 1 < args.length) {
      // 使用命令行提供的 prompt
      customPrompt = args[promptIndex + 1];
      console.log("使用自定義 prompt");
    } else if (promptFileIndex !== -1 && promptFileIndex + 1 < args.length) {
      // 從檔案讀取 prompt
      const promptFilePath = args[promptFileIndex + 1];
      try {
        const { readFile } = await import("fs/promises");
        customPrompt = await readFile(promptFilePath, "utf8");
        console.log(`從檔案讀取 prompt: ${promptFilePath}`);
      } catch (error) {
        console.error(`無法讀取 prompt 檔案: ${promptFilePath}`);
        throw error;
      }
    } else {
      console.log("使用預設 prompt");
    }

    const result = await processAudioFile(mediaPath, customPrompt || undefined);

    // 將結果寫入檔案，存到和音檔同一個資料夾下
    const outputDir = path.dirname(mediaPath);
    const outputPath = path.join(outputDir, `${result.info.slug}.json`);
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`已將轉錄結果儲存至：${outputPath}`);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}

main();
