const express = require("express");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = process.env.API_BASE; // örn: https://for-project-six.vercel.app
const WORKER_SECRET = process.env.WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.get("/health", (req, res) => res.send("ok"));

// Bu endpoint dışarıdan (cron-job.org gibi bir servisle) periyodik çağrılır.
// Her çağrıda sıradaki TEK işi işler, uzun sürerse timeout'a takılmasın diye.
app.get("/run-job", async (req, res) => {
  if (req.query.secret !== WORKER_SECRET) {
    return res.status(401).send("unauthorized");
  }

  try {
    const result = await processNextJob();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`worker listening on ${PORT}`));

async function processNextJob() {
  const jobRes = await fetch(`${API_BASE}/api/jobs/next`, {
    headers: { "x-worker-secret": WORKER_SECRET },
  });
  const jobData = await jobRes.json();

  if (!jobData.job) {
    return { message: "no pending job" };
  }

  const project = jobData.job;
  console.log(`processing project ${project.id} - ${project.title}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));

  try {
    const items = [...project.project_items].sort((a, b) => b.rank - a.rank); // 5 -> 1
    const processedClips = [];

    for (const item of items) {
      const rawPath = path.join(workDir, `raw_${item.rank}.mp4`);
      const outPath = path.join(workDir, `clip_${item.rank}.mp4`);

      console.log(`downloading rank ${item.rank}: ${item.source_url}`);
      downloadVideo(item.source_url, rawPath);

      console.log(`overlaying rank ${item.rank}: ${item.caption}`);
      overlayClip(rawPath, outPath, item.rank, item.caption);

      processedClips.push(outPath);
    }

    const listPath = path.join(workDir, "list.txt");
    fs.writeFileSync(
      listPath,
      processedClips.map((p) => `file '${p}'`).join("\n")
    );

    const finalPath = path.join(workDir, "final.mp4");
    run("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      finalPath,
    ]);

    const fileBuffer = fs.readFileSync(finalPath);
    const storagePath = `${project.id}.mp4`;

    const { error: uploadErr } = await supabase.storage
      .from("renders")
      .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });

    if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);

    const { data: publicUrlData } = supabase.storage
      .from("renders")
      .getPublicUrl(storagePath);

    await reportComplete(project.id, "done", publicUrlData.publicUrl, null);

    return { message: "done", project_id: project.id, url: publicUrlData.publicUrl };
  } catch (e) {
    console.error(`job ${project.id} failed:`, e);
    await reportComplete(project.id, "failed", null, String(e.message || e));
    return { message: "failed", project_id: project.id, error: String(e.message || e) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function downloadVideo(url, outPath) {
  // yt-dlp: tiktok/youtube shorts/instagram reels destekler
  run("yt-dlp", [
    "-f",
    "mp4/best",
    "--no-playlist",
    "-o",
    outPath,
    url,
  ]);
  if (!fs.existsSync(outPath)) {
    throw new Error(`indirme başarısız: ${url}`);
  }
}

function overlayClip(inPath, outPath, rank, caption) {
  // dikey formata (1080x1920) sabitle, üstte sıra numarası ve alt başlığı yak
  const safeCaption = caption.replace(/'/g, "\\'").replace(/:/g, "\\:");
  const drawText = [
    `drawtext=text='${rank}.':fontsize=90:fontcolor=0xE8973A:borderw=4:bordercolor=black:x=60:y=140`,
    `drawtext=text='${safeCaption}':fontsize=54:fontcolor=white:borderw=3:bordercolor=black:x=200:y=165`,
  ].join(",");

  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${drawText}`;

  run("ffmpeg", [
    "-y",
    "-i",
    inPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-t",
    "8", // her klipten en fazla 8 saniye al (hız + boyut için)
    outPath,
  ]);
}

async function reportComplete(projectId, status, outputUrl, error) {
  await fetch(`${API_BASE}/api/jobs/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": WORKER_SECRET,
    },
    body: JSON.stringify({ project_id: projectId, status, output_url: outputUrl, error }),
  });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
}
