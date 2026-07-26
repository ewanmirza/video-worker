const express = require("express");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

const API_BASE = process.env.API_BASE;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FONT_MAP = {
  Oswald: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  Inter: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "JetBrains Mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  Arial: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  Georgia: "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
};

app.get("/health", (req, res) => res.send("ok"));

app.get("/run-job", async (req, res) => {
  if (req.query.secret !== WORKER_SECRET) return res.status(401).send("unauthorized");
  try {
    const result = await processNextJob();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`worker listening on ${PORT}`));

// Timeline'da gösterilecek kare önizlemeleri (küçük jpg'ler, base64)
app.get("/thumbnails", async (req, res) => {
  if (req.query.secret !== WORKER_SECRET) return res.status(401).json({ error: "unauthorized" });
  const url = req.query.url;
  const count = Math.min(Number(req.query.count) || 10, 20);
  if (!url) return res.status(400).json({ error: "url gerekli" });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-thumbs-"));
  try {
    const rawPath = path.join(workDir, "raw.mp4");
    downloadVideo(url, rawPath);

    const probe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", rawPath,
    ]);
    const duration = parseFloat(probe.stdout.toString().trim()) || 10;

    const thumbs = [];
    for (let i = 0; i < count; i++) {
      const t = (duration / count) * i;
      const outPath = path.join(workDir, `thumb_${i}.jpg`);
      spawnSync("ffmpeg", [
        "-y", "-ss", String(t), "-i", rawPath,
        "-vframes", "1", "-vf", "scale=160:-1",
        "-q:v", "5", outPath,
      ]);
      if (fs.existsSync(outPath)) {
        const b64 = fs.readFileSync(outPath).toString("base64");
        thumbs.push(`data:image/jpeg;base64,${b64}`);
      }
    }

    res.json({ duration, thumbs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

app.get("/detect-scenes", async (req, res) => {
  if (req.query.secret !== WORKER_SECRET) return res.status(401).json({ error: "unauthorized" });
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url gerekli" });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-scan-"));
  try {
    const rawPath = path.join(workDir, "raw.mp4");
    downloadVideo(url, rawPath);

    const probe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", rawPath,
    ]);
    const duration = parseFloat(probe.stdout.toString().trim()) || 0;

    const result = spawnSync("ffmpeg", [
      "-i", rawPath, "-filter:v", "select='gt(scene,0.35)',showinfo", "-f", "null", "-",
    ]);
    const stderr = result.stderr.toString();
    const matches = [...stderr.matchAll(/pts_time:([\d.]+)/g)];
    const scenes = matches.map((m) => parseFloat(m[1])).filter((n) => !isNaN(n));

    res.json({ duration, scenes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

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
      await processWithPersistentOverlay(project, workDir, project.clip_segments, true);
    } else {
      await processWithPersistentOverlay(project, workDir, project.project_items, false);
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

// Ana pipeline: tüm sıra numaraları video boyunca sabit görünür,
// yalnızca o an oynayan klibin yanındaki başlık zamanlaması ile belirir/kaybolur.
async function processWithPersistentOverlay(project, workDir, rawItems, isMulticlip) {
  // isMulticlip: source_url tek, segment_index 0..N-1 zaten oynatma sırasıyla aynı
  // top5: source_url farklı, rank 5->1 oynatma sırası, ama liste 1(üst)->5(alt) sabit gösterilir

  const playOrder = isMulticlip
    ? [...rawItems].sort((a, b) => a.segment_index - b.segment_index)
    : [...rawItems].sort((a, b) => b.rank - a.rank); // 5,4,3,2,1

  const listOrder = isMulticlip
    ? playOrder // aynı sıra: 1,2,3...N üstten alta
    : [...rawItems].sort((a, b) => a.rank - b.rank); // 1(üst) -> 5(alt)

  const total = playOrder.length;
  const trimmedPaths = [];
  const timeline = []; // {label, caption, color, start, end}

  let cursor = 0;
  for (let i = 0; i < playOrder.length; i++) {
    const it = playOrder[i];
    const label = isMulticlip ? `${it.segment_index + 1}.` : `${it.rank}.`;

    await reportProgress(project.id, Math.round((i / total) * 70), `${label} indiriliyor: ${it.caption}`);

    const rawPath = path.join(workDir, `raw_${i}.mp4`);
    downloadVideo(it.source_url, rawPath);

    const start = it.trim_start ?? 0;
    const end = it.trim_end ?? start + 8;
    const duration = Math.max(0.5, Math.min(end - start, 15));

    const outPath = path.join(workDir, `trim_${i}.mp4`);
    // concat demuxer tüm parçalarda aynı stream yapısını bekler, bu yüzden
    // sessize alma için stream'i kaldırmak yerine (-an) seviyeyi 0 yapıyoruz
    const volumeLevel = it.audio_muted ? 0 : (it.audio_volume ?? 100) / 100;
    run("ffmpeg", [
      "-y", "-ss", String(start), "-i", rawPath, "-t", String(duration),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-filter:a", `volume=${volumeLevel}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac",
      outPath,
    ]);
    trimmedPaths.push(outPath);

    timeline.push({
      label,
      caption: it.caption,
      color: it.overlay_color || "#E8973A",
      font: it.overlay_font || "Oswald",
      start: cursor,
      end: cursor + duration,
    });
    cursor += duration;
  }

  await reportProgress(project.id, 75, "klipler birleştiriliyor");

  const listPath = path.join(workDir, "list.txt");
  fs.writeFileSync(listPath, trimmedPaths.map((p) => `file '${p}'`).join("\n"));
  const concatPath = path.join(workDir, "concat.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", concatPath]);

  await reportProgress(project.id, 85, "kalıcı numara listesi ve yazılar ekleniyor");

  // sabit sıra numaraları + başlıklar: video boyunca HEPSİ aynı anda görünür.
  // kullanıcı serbest konum (overlay_x/overlay_y, yüzde) belirlediyse onu kullan,
  // belirlemediyse listede sıralı (üstten alta) varsayılan konuma düş.
  const rowHeight = 110;
  const startY = 150;
  const CANVAS_W = 1080;
  const CANVAS_H = 1920;
  const drawTexts = [];

  listOrder.forEach((it, row) => {
    const label = isMulticlip ? `${it.segment_index + 1}.` : `${it.rank}.`;
    const color = `0x${(it.overlay_color || "#E8973A").replace("#", "")}`;
    const font = FONT_MAP[it.overlay_font] || FONT_MAP.Oswald;
    const safeCaption = String(it.caption).replace(/'/g, "\\'").replace(/:/g, "\\:");

    let x, y;
    if (it.overlay_x != null && it.overlay_y != null) {
      x = Math.round((it.overlay_x / 100) * CANVAS_W);
      y = Math.round((it.overlay_y / 100) * CANVAS_H);
    } else {
      x = 60;
      y = startY + row * rowHeight;
    }

    // numara
    drawTexts.push(
      `drawtext=fontfile=${font}:text='${label}':fontsize=56:fontcolor=${color}:borderw=3:bordercolor=black:x=${x}:y=${y}`
    );
    // başlık (numaranın hemen sağında/altında, her zaman görünür)
    drawTexts.push(
      `drawtext=fontfile=${font}:text='${safeCaption}':fontsize=38:fontcolor=white:borderw=2:bordercolor=black:x=${x + 110}:y=${y + 10}`
    );
  });

  const textLayers = (project.overlay_layers || []).filter((l) => l.layer_type === "text");
  const imageLayers = (project.overlay_layers || []).filter((l) => l.layer_type === "image");

  textLayers.forEach((l) => {
    const x = Math.round((l.overlay_x / 100) * CANVAS_W);
    const y = Math.round((l.overlay_y / 100) * CANVAS_H);
    const color = `0x${(l.overlay_color || "#E8973A").replace("#", "")}`;
    const font = FONT_MAP[l.overlay_font] || FONT_MAP.Oswald;
    const safeText = String(l.content).replace(/'/g, "\\'").replace(/:/g, "\\:");
    const enable =
      l.end_time != null
        ? `:enable='between(t\\,${l.start_time}\\,${l.end_time})'`
        : l.start_time
        ? `:enable='gte(t\\,${l.start_time})'`
        : "";
    drawTexts.push(
      `drawtext=fontfile=${font}:text='${safeText}':fontsize=${l.font_size || 40}:fontcolor=${color}:borderw=2:bordercolor=black:x=${x}:y=${y}${enable}`
    );
  });

  const overlaidPath = path.join(workDir, "overlaid.mp4");
  run("ffmpeg", [
    "-y", "-i", concatPath,
    "-vf", drawTexts.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy",
    overlaidPath,
  ]);

  let withImagesPath = overlaidPath;

  if (imageLayers.length > 0) {
    await reportProgress(project.id, 90, "görsel katmanlar ekleniyor");
    try {
      const imgInputs = [];
      for (let i = 0; i < imageLayers.length; i++) {
        const l = imageLayers[i];
        const imgPath = path.join(workDir, `layer_img_${i}.png`);
        const resp = await fetch(l.content);
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(imgPath, buf);
        imgInputs.push({ path: imgPath, layer: l });
      }

      const args = ["-y", "-i", overlaidPath];
      imgInputs.forEach((i) => args.push("-i", i.path));

      let filter = "";
      let lastLabel = "0:v";
      imgInputs.forEach((i, idx) => {
        const w = Math.round((i.layer.image_width / 100) * CANVAS_W);
        const x = Math.round((i.layer.overlay_x / 100) * CANVAS_W);
        const y = Math.round((i.layer.overlay_y / 100) * CANVAS_H);
        const enable =
          i.layer.end_time != null
            ? `:enable='between(t\\,${i.layer.start_time}\\,${i.layer.end_time})'`
            : i.layer.start_time
            ? `:enable='gte(t\\,${i.layer.start_time})'`
            : "";
        const scaledLabel = `s${idx}`;
        const outLabel = idx === imgInputs.length - 1 ? "vout" : `v${idx}`;
        filter += `[${idx + 1}:v]scale=${w}:-1[${scaledLabel}];`;
        filter += `[${lastLabel}][${scaledLabel}]overlay=${x}:${y}${enable}[${outLabel}];`;
        lastLabel = outLabel;
      });
      filter = filter.slice(0, -1); // son ; işaretini kaldır

      const imagedPath = path.join(workDir, "with_images.mp4");
      run("ffmpeg", [
        ...args,
        "-filter_complex", filter,
        "-map", "[vout]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy",
        imagedPath,
      ]);
      withImagesPath = imagedPath;
    } catch (e) {
      console.error("görsel katmanlar eklenemedi, atlanıyor:", e);
    }
  }

  let finalPath = withImagesPath;

  if (project.bg_music_url) {
    await reportProgress(project.id, 92, "arka plan müziği ekleniyor");
    try {
      const musicRawPath = path.join(workDir, "music_raw");
      run("yt-dlp", ["-x", "--audio-format", "mp3", "--no-playlist", "-o", musicRawPath + ".%(ext)s", project.bg_music_url]);
      const musicPath = musicRawPath + ".mp3";

      if (fs.existsSync(musicPath)) {
        const mixedPath = path.join(workDir, "mixed.mp4");
        const musicVol = (project.bg_music_volume ?? 25) / 100;
        run("ffmpeg", [
          "-y", "-i", withImagesPath, "-stream_loop", "-1", "-i", musicPath,
          "-filter_complex",
          `[1:a]volume=${musicVol}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
          "-map", "0:v", "-map", "[aout]",
          "-c:v", "copy", "-c:a", "aac", "-shortest",
          mixedPath,
        ]);
        finalPath = mixedPath;
      }
    } catch (e) {
      console.error("arka plan müziği eklenemedi, müziksiz devam ediliyor:", e);
    }
  }

  // kullanıcı bu arada iptal ettiyse yüklemeyi atla
  const check = await fetch(`${API_BASE}/api/projects?id=${project.id}`).then((r) => r.json());
  if (check.project?.cancel_requested) {
    console.log(`project ${project.id} was cancelled, skipping upload`);
    return;
  }

  await reportProgress(project.id, 95, "yükleniyor");

  const fileBuffer = fs.readFileSync(finalPath);
  const storagePath = `${project.id}.mp4`;
  const { error: uploadErr } = await supabase.storage
    .from("renders")
    .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
  if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);

  const { data: publicUrlData } = supabase.storage.from("renders").getPublicUrl(storagePath);
  await reportComplete(project.id, "done", publicUrlData.publicUrl, null);
}

function downloadVideo(url, outPath, retries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = spawnSync("yt-dlp", ["-f", "mp4/best", "--no-playlist", "-o", outPath, url], {
      stdio: "inherit",
    });
    if (result.status === 0 && fs.existsSync(outPath)) return;
    lastErr = `yt-dlp exited with code ${result.status}`;
    console.error(`indirme denemesi ${attempt}/${retries} başarısız: ${url}`);
  }
  throw new Error(`indirme başarısız (${retries} deneme): ${url} — ${lastErr}`);
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
