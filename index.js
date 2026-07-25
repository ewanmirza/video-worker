const express = require("express");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = process.env.API_BASE;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// yaklaşık font eşlemesi (Debian'da hazır bulunan fontlarla)
const FONT_MAP = {
  Oswald: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  Inter: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "JetBrains Mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  Arial: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  Georgia: "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
};

app.get("/health", (req, res) => res.send("ok"));

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
  if (!jobData.job) return { message: "no pending job" };

  const project = jobData.job;
  console.log(`processing project ${project.id} (${project.project_type}) - ${project.title}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));

  try {
    if (project.project_type === "multiclip") {
      await processMulticlip(project, workDir);
    } else {
      await processTop5(project, workDir);
    }
    return { message: "done", project_id: project.id };
  } catch (e) {
    console.error(`job ${project.id} failed:`, e);
    await reportComplete(project.id, "failed", null, String(e.message || e));
    return { message: "failed", project_id: project.id, error: String(e.message || e) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function processTop5(project, workDir) {
  const items = [...project.project_items].sort((a, b) => b.rank - a.rank); // 5 -> 1
  const total = items.length;
  const processedClips = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    await reportProgress(project.id, Math.round((i / total) * 90), `${item.rank}. klip indiriliyor: ${item.caption}`);

    const rawPath = path.join(workDir, `raw_${item.rank}.mp4`);
    const outPath = path.join(workDir, `clip_${item.rank}.mp4`);

    downloadVideo(item.source_url, rawPath);

    await reportProgress(project.id, Math.round(((i + 0.5) / total) * 90), `${item.rank}. klibe yazı ekleniyor: ${item.caption}`);
    overlayClip(rawPath, outPath, {
      rank: item.rank,
      caption: item.caption,
      trimStart: item.trim_start ?? 0,
      trimEnd: item.trim_end,
      color: item.overlay_color || "#E8973A",
      font: item.overlay_font || "Oswald",
      position: item.overlay_position || "top",
    });

    processedClips.push(outPath);
  }

  await reportProgress(project.id, 92, "klipler birleştiriliyor");

  const listPath = path.join(workDir, "list.txt");
  fs.writeFileSync(listPath, processedClips.map((p) => `file '${p}'`).join("\n"));

  const finalPath = path.join(workDir, "final.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", finalPath]);

  await reportProgress(project.id, 96, "yükleniyor");

  const fileBuffer = fs.readFileSync(finalPath);
  const storagePath = `${project.id}.mp4`;
  const { error: uploadErr } = await supabase.storage
    .from("renders")
    .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
  if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);

  const { data: publicUrlData } = supabase.storage.from("renders").getPublicUrl(storagePath);
  await reportComplete(project.id, "done", publicUrlData.publicUrl, null);
}

async function processMulticlip(project, workDir) {
  const segments = [...project.clip_segments].sort((a, b) => a.segment_index - b.segment_index);
  const total = segments.length;

  // aynı kaynak videoyu tekrar tekrar indirmemek için tek sefer indir
  const sourceUrl = segments[0]?.source_url;
  const rawPath = path.join(workDir, "source_raw.mp4");
  await reportProgress(project.id, 5, "kaynak video indiriliyor");
  downloadVideo(sourceUrl, rawPath);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    await reportProgress(
      project.id,
      10 + Math.round((i / total) * 85),
      `${i + 1}. kesit işleniyor: ${seg.caption}`
    );

    const outPath = path.join(workDir, `seg_${seg.segment_index}.mp4`);
    overlayClip(rawPath, outPath, {
      rank: null,
      caption: seg.caption,
      trimStart: seg.trim_start,
      trimEnd: seg.trim_end,
      color: seg.overlay_color || "#E8973A",
      font: seg.overlay_font || "Oswald",
      position: seg.overlay_position || "top",
    });

    const fileBuffer = fs.readFileSync(outPath);
    const storagePath = `${project.id}/segment_${seg.segment_index}.mp4`;
    const { error: uploadErr } = await supabase.storage
      .from("renders")
      .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadErr) throw new Error(`segment upload failed: ${uploadErr.message}`);

    const { data: publicUrlData } = supabase.storage.from("renders").getPublicUrl(storagePath);
    await supabase.from("clip_segments").update({ output_url: publicUrlData.publicUrl }).eq("id", seg.id);
  }

  await reportComplete(project.id, "done", null, null);
}

function downloadVideo(url, outPath) {
  run("yt-dlp", ["-f", "mp4/best", "--no-playlist", "-o", outPath, url]);
  if (!fs.existsSync(outPath)) throw new Error(`indirme başarısız: ${url}`);
}

function overlayClip(inPath, outPath, { rank, caption, trimStart, trimEnd, color, font, position }) {
  const safeCaption = String(caption).replace(/'/g, "\\'").replace(/:/g, "\\:");
  const fontFile = FONT_MAP[font] || FONT_MAP.Oswald;
  const hexColor = `0x${(color || "#E8973A").replace("#", "")}`;

  const yPos = { top: "140", center: "(h-text_h)/2", bottom: "h-220" }[position] || "140";
  const yPosCaption = { top: "165", center: "(h-text_h)/2+70", bottom: "h-160" }[position] || "165";

  const drawTexts = [];
  if (rank !== null && rank !== undefined) {
    drawTexts.push(
      `drawtext=fontfile=${fontFile}:text='${rank}.':fontsize=90:fontcolor=${hexColor}:borderw=4:bordercolor=black:x=60:y=${yPos}`
    );
    drawTexts.push(
      `drawtext=fontfile=${fontFile}:text='${safeCaption}':fontsize=54:fontcolor=white:borderw=3:bordercolor=black:x=200:y=${yPosCaption}`
    );
  } else {
    drawTexts.push(
      `drawtext=fontfile=${fontFile}:text='${safeCaption}':fontsize=54:fontcolor=${hexColor}:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${yPos}`
    );
  }

  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${drawTexts.join(",")}`;

  const start = trimStart || 0;
  const duration = trimEnd ? Math.max(0.5, Math.min(trimEnd - start, 15)) : 8; // en fazla 15sn

  run("ffmpeg", [
    "-y",
    "-ss",
    String(start),
    "-i",
    inPath,
    "-t",
    String(duration),
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
    outPath,
  ]);
}

async function reportComplete(projectId, status, outputUrl, error) {
  await fetch(`${API_BASE}/api/jobs/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ project_id: projectId, status, output_url: outputUrl, error }),
  });
}

async function reportProgress(projectId, progress, currentStep) {
  try {
    await fetch(`${API_BASE}/api/jobs/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
      body: JSON.stringify({ project_id: projectId, progress, current_step: currentStep }),
    });
  } catch (e) {
    console.error("progress report failed", e);
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
}
