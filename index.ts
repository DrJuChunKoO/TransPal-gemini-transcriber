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

// 提取音訊片段
async function extractAudioSegment(
  inputPath: string,
  startTime: number,
  endTime: number,
  outputPath: string
) {
  const duration = endTime - startTime;
  const command = `ffmpeg -ss ${startTime} -t ${duration} -i "${inputPath}" -c:a libmp3lame -b:a 128k "${outputPath}"`;
  await execAsync(command);
}

// 分割音訊檔案
async function splitAudio(
  filePath: string,
  outputDir: string,
  segmentTime: number = 60
) {
  await mkdir(outputDir, { recursive: true });
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
          process.env.TRANSCRIPTION_MODEL || "google/gemini-3-flash-preview"
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
                text: "請轉錄這個音訊片段。請務必使用系統提示中提供的說話者代號（如果匹配），並保持與前文的一致性。",
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

async function discoverSpeakers(
  audioPath: string,
  tempDir: string
): Promise<string[]> {
  console.log("正在進行初步說話者識別...");
  const samplePath = path.join(tempDir, "discovery_sample.mp3");
  // 提取前 10 分鐘作為樣本進行識別
  try {
    await extractAudioSegment(audioPath, 0, 600, samplePath);
    const fileData = await readFile(samplePath);

    const { output } = await generateText({
      model: openrouter(
        process.env.OPENROUTER_MODEL || "google/gemini-3-flash-preview"
      ),
      output: Output.object({
        schema: z.object({
          speakers: z.array(
            z.object({
              id: z.string().describe("代號，如 SPEAKER_01"),
              description: z
                .string()
                .describe("聲音特徵描述（音色、語調、性別、角色）"),
            })
          ),
        }),
      }),
      messages: [
        {
          role: "system",
          content:
            "你是一個專業的音訊分析專家。請分析提供的音訊，識別出所有主要的說話者，並描述他們的聲音特徵，以便後續轉錄時保持一致性。",
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
              text: "請識別這段音訊中的所有說話者，並提供簡短的特徵描述。",
            },
          ],
        },
      ],
    });

    return output.speakers.map((s) => `${s.id}: ${s.description}`);
  } catch (error) {
    console.error("說話者識別失敗，將跳過此步驟：", error);
    return [];
  }
}

async function identifySpeakersWithAudio(
  accumulatedResults: accumulatedResultsType,
  originalAudioPath: string,
  tempDir: string
) {
  console.log("正在進行增量式說話者身分識別...");

  const identificationChunkTime = 300; // 5 分鐘一組
  const maxTime = Math.max(
    ...accumulatedResults.transcription.map((i) => i.endTime),
    0
  );
  const numChunks = Math.ceil(maxTime / identificationChunkTime);

  let globalMapping: Record<string, string> = {};
  const confirmedSpeakers = new Map<string, { path: string; text: string }>();
  const samplesDir = path.join(tempDir, "samples");
  await mkdir(samplesDir, { recursive: true });

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const startTime = chunkIdx * identificationChunkTime;
    const endTime = (chunkIdx + 1) * identificationChunkTime;

    const chunkItems = accumulatedResults.transcription.filter(
      (i) => i.startTime >= startTime && i.startTime < endTime
    );

    if (chunkItems.length === 0) continue;

    // 找出本區塊中尚未確定身分的代號
    const currentChunkSpeakers = new Set(chunkItems.map((i) => i.speaker));
    const unknownSpeakers = Array.from(currentChunkSpeakers).filter(
      (s) => !globalMapping[s]
    );

    if (unknownSpeakers.length === 0) continue;

    console.log(
      `正在處理第 ${
        chunkIdx + 1
      }/${numChunks} 個時間段 (${startTime}s - ${endTime}s)，發現 ${
        unknownSpeakers.length
      } 個新代號...`
    );

    // 提取新代號的樣本
    const newSamples: Array<{ speaker: string; text: string; path: string }> =
      [];
    for (const speaker of unknownSpeakers) {
      const speakerItems = chunkItems.filter((i) => i.speaker === speaker);
      const bestItem = speakerItems.reduce((prev, curr) =>
        curr.endTime - curr.startTime > prev.endTime - prev.startTime
          ? curr
          : prev
      );

      const samplePath = path.join(
        samplesDir,
        `sample_${speaker}_chunk${chunkIdx}.mp3`
      );
      await extractAudioSegment(
        originalAudioPath,
        Math.max(0, bestItem.startTime - 0.2),
        bestItem.endTime + 0.2,
        samplePath
      );
      newSamples.push({ speaker, text: bestItem.text, path: samplePath });
    }

    // 準備 AI 請求
    const userContent: any[] = [
      {
        type: "text",
        text: `這是第 ${
          chunkIdx + 1
        }/${numChunks} 個時間段的音訊樣本。請分析聲音特徵，將新的代號對應到真實身分，或與先前的說話者合併。`,
      },
    ];

    // 加入參考樣本（已確定的說話者）
    if (confirmedSpeakers.size > 0) {
      userContent.push({ type: "text", text: "\n### 已確定的說話者參考：\n" });
      for (const [name, info] of confirmedSpeakers.entries()) {
        const fileData = await readFile(info.path);
        userContent.push({
          type: "text",
          text: `真實身分：${name}\n參考文字：${info.text}`,
        });
        userContent.push({
          type: "file",
          data: fileData,
          mediaType: "audio/mp3",
        });
      }
    }

    // 加入待識別樣本
    userContent.push({ type: "text", text: "\n### 待識別的新代號：\n" });
    for (const sample of newSamples) {
      const fileData = await readFile(sample.path);
      userContent.push({
        type: "text",
        text: `代號：${sample.speaker}\n文字內容：${sample.text}`,
      });
      userContent.push({
        type: "file",
        data: fileData,
        mediaType: "audio/mp3",
      });
    }

    userContent.push({
      type: "text",
      text: "\n請提供對照表（JSON 格式），包含所有待識別代號的對應身分。",
    });

    const { output } = await generateText({
      model: openrouter(
        process.env.OPENROUTER_MODEL || "google/gemini-3-flash-preview"
      ),
      output: Output.object({
        schema: z.object({
          mapping: z
            .record(z.string(), z.string())
            .describe("原始代號 -> 統一後名稱 的對照表"),
        }),
      }),
      messages: [
        {
          role: "system",
          content:
            "你是一個專業的音訊分析專家。請根據提供的音訊片段與文字內容，建立說話者代號與真實身分的對照表。請參考已確定的說話者，確保身分一致性。",
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    // 更新 globalMapping
    for (const [original, mapped] of Object.entries(output.mapping)) {
      globalMapping[original] = mapped;
      if (!confirmedSpeakers.has(mapped)) {
        const sample = newSamples.find((s) => s.speaker === original);
        if (sample) {
          confirmedSpeakers.set(mapped, {
            path: sample.path,
            text: sample.text,
          });
        }
      }
    }
  }

  // 套用 mapping
  const newTranscription = accumulatedResults.transcription.map((item) => ({
    ...item,
    speaker: globalMapping[item.speaker] || item.speaker,
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
  const tempDir = path.join(process.cwd(), "temp_chunks_" + Date.now());

  let accumulatedResults: accumulatedResultsType = {
    title: "",
    slug: "",
    transcription: [],
    summary: "",
  };

  try {
    const segmentTime = 60 * 10; // 增加到 3 分鐘以獲得更好的上下文
    const chunkPaths = await splitAudio(filePath, tempDir, segmentTime);
    console.log(`共分割為 ${chunkPaths.length} 個片段`);

    // 1. 先進行說話者識別
    const initialSpeakers = await discoverSpeakers(filePath, tempDir);

    // 2. 順序轉錄以保持上下文一致性
    console.log(`開始順序轉錄以確保說話者一致性...`);
    const allChunkResults = [];
    let knownSpeakers = [...initialSpeakers];
    let previousContext = "";

    for (let i = 0; i < chunkPaths.length; i++) {
      const chunkTranscription = await transcribeChunk(
        chunkPaths[i],
        i,
        previousContext,
        knownSpeakers,
        customPrompt,
        promptTemplate
      );

      allChunkResults.push({ index: i, transcription: chunkTranscription });

      // 更新已知說話者（去重）
      const currentSpeakers = [
        ...new Set(chunkTranscription.map((t) => t.speaker)),
      ];
      for (const s of currentSpeakers) {
        if (!knownSpeakers.some((ks) => ks.startsWith(s))) {
          knownSpeakers.push(s);
        }
      }

      // 更新上下文（從已累積的結果中取最後 100 句，確保全域一致性）
      const allCurrentTranscription = allChunkResults.flatMap(
        (r) => r.transcription
      );
      previousContext = allCurrentTranscription
        .slice(-100)
        .map((t) => `${t.speaker}: ${t.text}`)
        .join("\n");
    }

    for (const chunkResult of allChunkResults) {
      const timeOffset = chunkResult.index * segmentTime;
      for (const item of chunkResult.transcription) {
        accumulatedResults.transcription.push({
          ...item,
          startTime: item.startTime + timeOffset,
          endTime: item.endTime + timeOffset,
        });
      }
    }

    accumulatedResults = await identifySpeakersWithAudio(
      accumulatedResults,
      filePath,
      tempDir
    );

    accumulatedResults = await generateTitleAndSummary(accumulatedResults);

    const transcription = processTranscription(
      accumulatedResults,
      nameWithoutExt
    );

    return transcription;
  } catch (error: any) {
    console.error("處理過程中發生錯誤：", error);
    throw error;
  } finally {
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
  const transcriptionText = JSON.stringify(accumulatedResults.transcription);

  const { output } = await generateText({
    model: openrouter(
      process.env.OPENROUTER_MODEL || "google/gemini-3-flash-preview"
    ),
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
        content: `逐字稿內容：${transcriptionText.slice(0, 500000)}`,
      },
    ],
  });

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

    const extractIndex = args.indexOf("--extract");
    if (extractIndex !== -1) {
      const jsonPath = args[extractIndex + 1];
      const targetId = args[extractIndex + 2];
      const audioPath = args[0];

      if (!jsonPath || !targetId || !audioPath) {
        console.log("提取模式使用方式：");
        console.log(
          "  pnpm start <原始音訊路徑> --extract <JSON路徑> <項目ID>"
        );
        return;
      }

      const jsonData = JSON.parse(await readFile(jsonPath, "utf8"));
      const item = jsonData.content.find((i: any) => i.id === targetId);

      if (!item) {
        console.error(`找不到 ID 為 ${targetId} 的項目`);
        return;
      }

      const outputDir = path.dirname(jsonPath);
      const outputPath = path.join(outputDir, `extract_${targetId}.mp3`);
      const start = Math.max(0, item.start - 0.5);
      const end = item.end + 0.5;

      await extractAudioSegment(audioPath, start, end, outputPath);
      console.log(`音訊片段已提取至：${outputPath}`);
      return;
    }

    const mediaPath = args[0];

    if (!mediaPath) {
      console.log("使用方式：");
      console.log("  pnpm start <音訊檔案路徑> [--prompt <自定義prompt>]");
      console.log(
        "  pnpm start <音訊檔案路徑> [--prompt-file <prompt檔案路徑>]"
      );
      console.log("  pnpm start <音訊檔案路徑> --extract <JSON路徑> <項目ID>");
      console.log("");
      console.log("範例：");
      console.log("  pnpm start audio.mp4");
      console.log(
        "  pnpm start audio.mp4 --prompt '請產生詳細的逐字稿並分析講者情緒'"
      );
      console.log("  pnpm start audio.mp4 --prompt-file custom-prompt.txt");
      console.log("  pnpm start audio.mp4 --extract result.json some-uuid");
      throw new Error("請提供音訊檔案路徑");
    }

    let customPrompt = null;
    const promptIndex = args.indexOf("--prompt");
    const promptFileIndex = args.indexOf("--prompt-file");

    if (promptIndex !== -1 && promptIndex + 1 < args.length) {
      customPrompt = args[promptIndex + 1];
      console.log("使用自定義 prompt");
    } else if (promptFileIndex !== -1 && promptFileIndex + 1 < args.length) {
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
    const outputDir = path.dirname(mediaPath);
    const outputPath = path.join(outputDir, `${result.info.slug}.json`);
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`已將轉錄結果儲存至：${outputPath}`);
    console.log("");
    console.log(
      "提示：若發現說話者誤植或時間不準，可以使用以下指令提取特定片段進行確認："
    );
    console.log(
      `  pnpm start "${mediaPath}" --extract "${outputPath}" <項目ID>`
    );
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}

main();
