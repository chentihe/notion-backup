#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */
import axios from "axios";
import extract from "extract-zip";
import { retry } from "async";
import { createWriteStream, mkdirSync, rmdirSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";

dotenv.config();

const client = axios.create({
  baseURL: process.env.NOTION_API,
  headers: {
    Cookie: `token_v2=${process.env.NOTION_TOKEN_V2}`,
  },
});

const die = (str) => {
  console.error(str);
  process.exit(1);
};

const spaceIds = process.env.NOTION_SPACE_IDS.split(",").map((spaceId) =>
  spaceId.trim()
);

const formats = process.env.EXPORT_FORMATS.split(",").map((format) =>
  format.trim()
);

if (!process.env.NOTION_TOKEN_V2 || !process.env.NOTION_SPACE_IDS) {
  die(`Need to have both NOTION_TOKEN_V2 and NOTION_SPACE_IDS defined in the environment.
See https://medium.com/@arturburtsev/automated-notion-backups-f6af4edc298d for
notes on how to get that information.`);
}

const post = async (endpoint, data) => {
  return client.post(endpoint, data);
};

const sleep = async (seconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

// formats: markdown, html
const exportFromNotion = async (spaceId, format) => {
  try {
    const {
      data: { taskId },
    } = await post("enqueueTask", {
      task: {
        eventName: "exportSpace",
        request: {
          spaceId: spaceId,
          exportOptions: {
            exportType: format,
            timeZone: "Asia/Taipei",
            locale: "en",
          },
        },
      },
    });

    console.warn(`Enqueued task ${taskId}`);
    const failCount = 0;
    let exportURL;

    while (true) {
      if (failCount >= 5) break;
      await sleep(10);

      const {
        data: { results: tasks },
      } = await retry({ times: 3, interval: 2000 }, async () =>
        post("getTasks", { taskIds: [taskId] })
      );

      const task = tasks.find((t) => t.id === taskId);
      console.warn(JSON.stringify(task, null, 2)); // DBG
      if (!task) {
        failCount++;
        console.warn(`No task, waiting.`);
        continue;
      }
      if (!task.status) {
        failCount++;
        console.warn(
          `No task status, waiting. Task was:\n${JSON.stringify(task, null, 2)}`
        );
        continue;
      }
      if (task.state === "in_progress")
        console.warn(`Pages exported: ${task.status.pagesExported}`);
      if (task.state === "failure") {
        failCount++;
        console.warn(`Task error: ${task.error}`);
        continue;
      }
      if (task.state === "success") {
        exportURL = task.status.exportURL;
        break;
      }
    }

    const res = await client({
      method: "GET",
      url: exportURL,
      responseType: "stream",
    });

    const stream = res.data.pipe(
      createWriteStream(join(process.cwd(), `${spaceId}-${format}.zip`))
    );
    await new Promise((resolve, reject) => {
      stream.on("close", resolve);
      stream.on("error", reject);
    });
  } catch (err) {
    die(err);
  }
};

const extractFile = (spaceId, formats) => {
  formats.forEach(async (format) => {
    const dir = join(process.cwd(), format);
    const file = join(process.cwd(), `${format}.zip`);
    await exportFromNotion(spaceId, format);
    rmdirSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    await extract(file, { dir: dir });
  });
};

const run = async () => {
  spaceIds.forEach((spaceId) => extractFile(spaceId, formats));
};

run();
